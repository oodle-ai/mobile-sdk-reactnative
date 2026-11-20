import Darwin
import Foundation
import Network
import QuartzCore
import UIKit

/// Native half of the SDK on iOS. OodleRum.mm forwards each TurboModule
/// call here. Structured results go back to JS as JSON strings.
@objc(OodleRumImpl)
public final class OodleRumImpl: NSObject {
  @objc public static let shared = OodleRumImpl()

  private let directory: URL
  private let events = NativeEventQueue()
  private let vitals = VitalsCollector()
  private var watchdog: HangWatchdog?
  private let pathMonitor = NWPathMonitor()
  private let lock = NSLock()
  private var connection = "unknown"

  override private init() {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    directory = base.appendingPathComponent("oodle-rum", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    super.init()
    pathMonitor.pathUpdateHandler = { [weak self] path in
      let value: String
      if path.status != .satisfied {
        value = "none"
      } else if path.usesInterfaceType(.wifi) {
        value = "wifi"
      } else if path.usesInterfaceType(.cellular) {
        value = "cellular"
      } else if path.usesInterfaceType(.wiredEthernet) {
        value = "ethernet"
      } else {
        value = "other"
      }
      self?.lock.lock()
      self?.connection = value
      self?.lock.unlock()
    }
    pathMonitor.start(queue: DispatchQueue(label: "ai.oodle.rum.network", qos: .utility))
    NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
    ) { [weak self] _ in
      self?.events.add(["type": "memory_warning", "timestamp": Self.nowMs(), "message": "Memory warning"])
    }
  }

  static func nowMs() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
  }

  /// Keys are sorted, so the same object always gives the same text.
  static func json(_ object: Any) -> String {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  // MARK: Device

  @objc public func storageDirectory() -> String {
    directory.path
  }

  @objc public func deviceInfo() -> String {
    let bundle = Bundle.main
    let screen = UIScreen.main
    var info: [String: Any] = [
      "brand": "Apple",
      "model": Self.modelIdentifier(),
      "osName": UIDevice.current.systemName == "iPadOS" ? "iPadOS" : "iOS",
      "osVersion": UIDevice.current.systemVersion,
      "appVersion": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
      "appBuild": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
      "bundleId": bundle.bundleIdentifier ?? "",
      "deviceType": UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "mobile",
      "screenWidth": Double(screen.bounds.width),
      "screenHeight": Double(screen.bounds.height),
      "scale": Double(screen.scale),
      "locale": Locale.preferredLanguages.first ?? "",
    ]
    info["processStartMs"] = Self.processStartMs()
    return Self.json(info)
  }

  /// "iPhone15,2". The simulator reports the model it simulates.
  static func modelIdentifier() -> String {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
      return simulated
    }
    var system = utsname()
    uname(&system)
    let mirror = Mirror(reflecting: system.machine)
    return mirror.children.reduce(into: "") { result, element in
      if let value = element.value as? Int8, value != 0 {
        result.append(Character(UnicodeScalar(UInt8(value))))
      }
    }
  }

  /// Wall clock time the process started, or 0 when the system started the
  /// process early ("prewarming"); a start measured from then is not a
  /// launch the user waited for.
  static func processStartMs() -> Double {
    if ProcessInfo.processInfo.environment["ActivePrewarm"] == "1" { return 0 }
    var kinfo = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, u_int(mib.count), &kinfo, &size, nil, 0) == 0 else { return 0 }
    let start = kinfo.kp_proc.p_un.__p_starttime
    return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
  }

  // MARK: Storage

  private func fileURL(_ key: String) -> URL {
    let safe = String(key.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." || $0 == "-" ? $0 : "_" })
    return directory.appendingPathComponent(safe)
  }

  // Every write takes a version number for its key. A background write
  // that is older than the last write of its key is skipped, so a
  // synchronous write on the fatal error path is never replaced by an
  // older background write.
  private let storageLock = NSLock()
  private var storageVersions: [String: Int] = [:]
  private let storageQueue = DispatchQueue(label: "ai.oodle.rum.storage", qos: .utility)

  private func bumpVersion(_ key: String) -> Int {
    let next = (storageVersions[key] ?? 0) + 1
    storageVersions[key] = next
    return next
  }

  private func write(_ key: String, _ value: String) -> Bool {
    do {
      try value.write(to: fileURL(key), atomically: true, encoding: .utf8)
      return true
    } catch {
      return false
    }
  }

  @objc public func storageGet(_ key: String) -> String? {
    storageLock.lock()
    defer { storageLock.unlock() }
    return try? String(contentsOf: fileURL(key), encoding: .utf8)
  }

  @objc public func storageSet(_ key: String, value: String) -> Bool {
    storageLock.lock()
    defer { storageLock.unlock() }
    _ = bumpVersion(key)
    return write(key, value)
  }

  /// Writes on a background queue and calls `done` there.
  @objc public func storageSetAsync(_ key: String, value: String, done: @escaping (Bool) -> Void) {
    storageLock.lock()
    let version = bumpVersion(key)
    storageLock.unlock()
    storageQueue.async { [weak self] in
      guard let self = self else { return done(false) }
      self.storageLock.lock()
      let ok = self.storageVersions[key] == version ? self.write(key, value) : true
      self.storageLock.unlock()
      done(ok)
    }
  }

  @objc public func storageRemove(_ key: String) -> Bool {
    storageLock.lock()
    defer { storageLock.unlock() }
    _ = bumpVersion(key)
    return (try? FileManager.default.removeItem(at: fileURL(key))) != nil
  }

  // MARK: Watchdog, vitals, connectivity

  @objc public func startWatchdog(_ thresholdMs: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if watchdog == nil {
      let w = HangWatchdog(thresholdMs: thresholdMs > 0 ? thresholdMs : 2000, events: events)
      w.start()
      watchdog = w
    }
    return true
  }

  @objc public func drainNativeEvents() -> String {
    events.drain()
  }

  @objc public func startVitals() -> Bool {
    vitals.start()
    return true
  }

  @objc public func collectVitals() -> String {
    Self.json(vitals.collect())
  }

  @objc public func connectivity() -> String {
    lock.lock()
    defer { lock.unlock() }
    return connection
  }

  // MARK: Replay

  /// The last walk result. Read and written on the main thread only.
  private var lastCapture: String?

  /// Must run on the main thread. With `skipUnchanged`, a walk that gives
  /// the same result as the last one returns a short marker, so the JS
  /// side does not parse and compare the same screen again.
  @objc public func captureWireframes(_ optionsJson: String) -> String {
    var maxNodes = 2000
    var skipUnchanged = false
    if let data = optionsJson.data(using: .utf8),
       let options = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      if let n = options["maxNodes"] as? Int { maxNodes = n }
      skipUnchanged = (options["skipUnchanged"] as? Bool) ?? false
    }
    let result = Self.json(WireframeWalker(maxNodes: maxNodes).capture())
    if skipUnchanged && result == lastCapture {
      return "{\"unchanged\":true}"
    }
    lastCapture = result
    return result
  }
}

// MARK: - Native events

final class NativeEventQueue {
  private let lock = NSLock()
  private var items: [[String: Any]] = []
  private let max = 50

  func add(_ event: [String: Any]) {
    lock.lock()
    if items.count >= max { items.removeFirst() }
    items.append(event)
    lock.unlock()
  }

  func drain() -> String {
    lock.lock()
    let out = items
    items.removeAll()
    lock.unlock()
    guard JSONSerialization.isValidJSONObject(out),
          let data = try? JSONSerialization.data(withJSONObject: out)
    else { return "[]" }
    return String(data: data, encoding: .utf8) ?? "[]"
  }
}

// MARK: - Hang watchdog

/// Sends a block to the main queue and waits for it to run. A main thread
/// that does not run it within the threshold is a hang.
final class HangWatchdog {
  private let thresholdMs: Double
  private let events: NativeEventQueue
  private var thread: Thread?

  init(thresholdMs: Double, events: NativeEventQueue) {
    self.thresholdMs = thresholdMs
    self.events = events
  }

  func start() {
    let t = Thread { [weak self] in self?.run() }
    t.name = "oodle-rum-watchdog"
    t.qualityOfService = .utility
    t.start()
    thread = t
  }

  private func run() {
    while true {
      let semaphore = DispatchSemaphore(value: 0)
      let postedAt = CACurrentMediaTime()
      DispatchQueue.main.async { semaphore.signal() }
      if semaphore.wait(timeout: .now() + .milliseconds(Int(thresholdMs))) == .timedOut {
        // Still blocked: wait for the end so the event has the full duration.
        semaphore.wait()
        let blockedMs = (CACurrentMediaTime() - postedAt) * 1000
        events.add([
          "type": "app_hang",
          "timestamp": OodleRumImpl.nowMs() - Int64(blockedMs),
          "duration_ms": Int64(blockedMs),
        ])
      }
      Thread.sleep(forTimeInterval: 0.5)
    }
  }
}

// MARK: - Vitals

/// Frame, memory and CPU statistics since the last collect().
final class VitalsCollector: NSObject {
  private static let frozenSeconds = 0.7
  private static let pauseSeconds = 5.0

  private let lock = NSLock()
  private var link: CADisplayLink?
  private var timer: DispatchSourceTimer?
  private var lastFrame: CFTimeInterval = 0
  private var frames = 0
  private var frameTime: Double = 0
  private var slow = 0
  private var frozen = 0
  private var windowStart: CFTimeInterval = 0
  private var windowFrames = 0
  private var minFps: Double = 0
  private var memSum: Double = 0
  private var memSamples = 0
  private var memMax: UInt64 = 0
  private var intervalStart = CACurrentMediaTime()
  private var cpuStart = VitalsCollector.cpuSeconds()

  func start() {
    DispatchQueue.main.async {
      guard self.link == nil else { return }
      let link = CADisplayLink(target: self, selector: #selector(self.onFrame(_:)))
      link.add(to: .main, forMode: .common)
      self.link = link
      let center = NotificationCenter.default
      center.addObserver(self, selector: #selector(self.pause), name: UIApplication.didEnterBackgroundNotification, object: nil)
      center.addObserver(self, selector: #selector(self.resume), name: UIApplication.willEnterForegroundNotification, object: nil)
    }
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    t.schedule(deadline: .now(), repeating: 1.0)
    t.setEventHandler { [weak self] in self?.sampleMemory() }
    t.resume()
    timer = t
  }

  @objc private func pause() {
    link?.isPaused = true
    lock.lock()
    lastFrame = 0
    lock.unlock()
  }

  @objc private func resume() {
    link?.isPaused = false
  }

  @objc private func onFrame(_ link: CADisplayLink) {
    let now = link.timestamp
    let expected = max(link.targetTimestamp - link.timestamp, 1.0 / 120.0)
    lock.lock()
    defer { lock.unlock() }
    let last = lastFrame
    lastFrame = now
    if last == 0 {
      windowStart = now
      return
    }
    let delta = now - last
    if delta <= 0 || delta > Self.pauseSeconds {
      windowStart = now
      windowFrames = 0
      return
    }
    frames += 1
    frameTime += delta
    if delta > Self.frozenSeconds {
      frozen += 1
    } else if delta > expected * 1.5 {
      slow += 1
    }
    windowFrames += 1
    if now - windowStart >= 1.0 {
      let fps = Double(windowFrames) / (now - windowStart)
      if minFps == 0 || fps < minFps { minFps = fps }
      windowStart = now
      windowFrames = 0
    }
  }

  private func sampleMemory() {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return }
    let footprint = info.phys_footprint
    lock.lock()
    memSum += Double(footprint)
    memSamples += 1
    if footprint > memMax { memMax = footprint }
    lock.unlock()
  }

  /// User plus system CPU time of this process.
  static func cpuSeconds() -> Double {
    var usage = rusage()
    guard getrusage(RUSAGE_SELF, &usage) == 0 else { return -1 }
    let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
    let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
    return user + system
  }

  func collect() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    let now = CACurrentMediaTime()
    let duration = now - intervalStart
    var out: [String: Any] = ["duration_ms": Int64(duration * 1000)]
    if frames > 0, frameTime > 0 { out["refresh_rate_avg"] = Double(frames) / frameTime }
    if minFps > 0 { out["refresh_rate_min"] = minFps }
    out["slow_frame_count"] = slow
    out["frozen_frame_count"] = frozen
    if memSamples > 0 { out["memory_avg_bytes"] = Int64(memSum / Double(memSamples)) }
    if memMax > 0 { out["memory_max_bytes"] = Int64(memMax) }
    let cpu = Self.cpuSeconds()
    if cpu >= 0, cpuStart >= 0, duration > 0 {
      out["cpu_ms_per_sec"] = (cpu - cpuStart) * 1000 / duration
    }
    frames = 0
    frameTime = 0
    slow = 0
    frozen = 0
    minFps = 0
    windowFrames = 0
    windowStart = lastFrame
    memSum = 0
    memSamples = 0
    memMax = 0
    intervalStart = now
    cpuStart = cpu
    return out
  }
}
