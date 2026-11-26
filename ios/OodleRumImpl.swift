import Darwin
import Foundation
import Network
import QuartzCore
import UIKit

// A trap (Int(_:) of NaN, a force unwrap of nil) ends the app, and Swift
// cannot catch it. test/guard.test.ts fails on as!, try!, a force unwrap
// and an integer conversion in ios/*.swift. A conversion of a floating
// value goes through finiteInt64 or finiteInt. A line that needs one of
// these has a comment "// force: <reason>" or "// trap-free: <reason>" on
// the line before it.

/// The integer of a floating value. NaN gives 0, and a value out of range
/// gives the nearest bound: Int64(_:) traps on them.
func finiteInt64(_ value: Double) -> Int64 {
  guard value.isFinite else { return 0 }
  if value >= 9.2e18 { return Int64.max }
  if value <= -9.2e18 { return Int64.min }
  // trap-free: finite and in range.
  return Int64(value)
}

/// As finiteInt64. On iOS, Int has 64 bits.
func finiteInt(_ value: Double) -> Int {
  // trap-free: Int has 64 bits on iOS.
  Int(finiteInt64(value))
}

func finiteInt(_ value: CGFloat) -> Int {
  finiteInt(Double(value))
}

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
  /// The background task that lets the last uploads finish. Main thread only.
  private var uploadTask: UIBackgroundTaskIdentifier = .invalid

  /// How long the app keeps running after it leaves the screen, so the
  /// requests that JS sends as it goes get their answers. It is the
  /// request timeout of the transport (REQUEST_TIMEOUT_MS): a shorter window
  /// left a slow request unanswered. iOS may end the task sooner, and its
  /// expiration handler ends it then; the batch id lets the collector drop
  /// a body sent again after that.
  private static let uploadWindow: TimeInterval = 30

  override private init() {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSTemporaryDirectory())
    directory = base.appendingPathComponent("oodle-rum", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    // The outbox, the session and the saved user stay on this device. A
    // backup restored on another device would send its events again, and
    // continue its session there.
    var excluded = URLResourceValues()
    excluded.isExcludedFromBackup = true
    var backupTarget = directory
    try? backupTarget.setResourceValues(excluded)
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
    NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.beginUploadWindow()
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.endUploadWindow()
    }
  }

  /// iOS suspends an app seconds after it leaves the screen. JS sends its
  /// last events then, and keeps each request in the outbox until its
  /// answer arrives. An answer that arrived after the suspension was never
  /// read, so the next start sent the request again and the collector
  /// stored its events twice. A background task keeps the app running for
  /// `uploadWindow`, which these requests need.
  private func beginUploadWindow() {
    endUploadWindow()
    let task = UIApplication.shared.beginBackgroundTask(withName: "ai.oodle.rum.upload") { [weak self] in
      self?.endUploadWindow()
    }
    uploadTask = task
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.uploadWindow) { [weak self] in
      guard let self = self, self.uploadTask == task else { return }
      self.endUploadWindow()
    }
  }

  private func endUploadWindow() {
    guard uploadTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(uploadTask)
    uploadTask = .invalid
  }

  static func nowMs() -> Int64 {
    finiteInt64(Date().timeIntervalSince1970 * 1000)
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
        result.append(Character(UnicodeScalar(UInt8(bitPattern: value))))
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
    if let w = watchdog {
      w.setEnabled(true)
    } else {
      // Int(_:) traps on Infinity and NaN.
      let ms = thresholdMs.isFinite && thresholdMs > 0 ? min(thresholdMs, 60_000) : 2000
      let w = HangWatchdog(thresholdMs: ms, events: events)
      w.start()
      watchdog = w
    }
    return true
  }

  /// The session is not sampled: its hangs would not be sent.
  @objc public func stopWatchdog() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    watchdog?.setEnabled(false)
    return true
  }

  @objc public func drainNativeEvents() -> String {
    events.drain()
  }

  @objc public func startVitals() -> Bool {
    vitals.start()
    return true
  }

  @objc public func stopVitals() -> Bool {
    vitals.stop()
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

  /// The last walk result. Read and written on `captureQueue` only.
  fileprivate var lastCapture: NSDictionary?
  /// Compares and serializes walk results off the main thread.
  fileprivate let captureQueue = DispatchQueue(label: "ai.oodle.rum.replay", qos: .utility)
  /// True while a walk runs. Main thread only.
  fileprivate var capturing = false

  /// Starts a walk. Must run on the main thread. OodleRum.mm calls
  /// `step()` of the task on the main queue until it returns true, then
  /// `finish(_:)`. With `skipUnchanged`, a walk that gives the same result
  /// as the last one finishes with a short marker, so the JS side does not
  /// parse and compare the same screen again.
  @objc public func beginCapture(_ optionsJson: String) -> OodleCaptureTask {
    var maxNodes = 2000
    var skipUnchanged = false
    if let data = optionsJson.data(using: .utf8),
       let options = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      if let n = options["maxNodes"] as? Int { maxNodes = n }
      skipUnchanged = (options["skipUnchanged"] as? Bool) ?? false
    }
    // The JS side waits for each walk; this is only a guard.
    if capturing { return OodleCaptureTask(owner: self, walker: nil, skipUnchanged: true) }
    capturing = true
    return OodleCaptureTask(owner: self, walker: WireframeWalker(maxNodes: maxNodes), skipUnchanged: skipUnchanged)
  }
}

/// One walk of the view tree, run in slices on the main thread.
@objc(OodleCaptureTask)
public final class OodleCaptureTask: NSObject {
  private static let unchanged = "{\"unchanged\":true}"
  private weak var owner: OodleRumImpl?
  private let walker: WireframeWalker?
  private let skipUnchanged: Bool
  private var ended = false

  fileprivate init(owner: OodleRumImpl, walker: WireframeWalker?, skipUnchanged: Bool) {
    self.owner = owner
    self.walker = walker
    self.skipUnchanged = skipUnchanged
  }

  /// Runs one slice on the main thread. True when the walk is done.
  @objc public func step() -> Bool {
    guard let walker = walker, !ended else { return true }
    return walker.step()
  }

  /// Gives the result on a background queue. Call on the main thread
  /// after `step()` returned true.
  @objc public func finish(_ completion: @escaping (String) -> Void) {
    guard let walker = walker, let owner = owner, !ended else { return completion(Self.unchanged) }
    ended = true
    owner.capturing = false
    let result = walker.result()
    let skip = skipUnchanged
    owner.captureQueue.async { [weak owner] in
      let dict = result as NSDictionary
      if skip, let last = owner?.lastCapture, last.isEqual(dict) {
        return completion(Self.unchanged)
      }
      owner?.lastCapture = dict
      // Key order does not matter to the JS side, so the keys are not sorted.
      guard JSONSerialization.isValidJSONObject(result),
            let data = try? JSONSerialization.data(withJSONObject: result),
            let text = String(data: data, encoding: .utf8)
      else { return completion("{}") }
      completion(text)
    }
  }

  /// Ends a walk that failed. Main thread.
  @objc public func cancel() {
    if walker != nil, !ended { owner?.capturing = false }
    ended = true
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
/// that does not run it within the threshold is a hang. The thread waits,
/// and does not wake, while the app is in the background or the session is
/// not sampled.
final class HangWatchdog {
  private let thresholdMs: Double
  private let events: NativeEventQueue
  private var thread: Thread?
  private let condition = NSCondition()
  /// Guarded by `condition`.
  private var enabled = true
  private var foreground = true

  init(thresholdMs: Double, events: NativeEventQueue) {
    self.thresholdMs = thresholdMs
    self.events = events
    let center = NotificationCenter.default
    center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.update { $0.foreground = false }
    }
    center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
      self?.update { $0.foreground = true }
    }
  }

  func setEnabled(_ on: Bool) {
    update { $0.enabled = on }
  }

  private func update(_ change: (HangWatchdog) -> Void) {
    condition.lock()
    change(self)
    condition.signal()
    condition.unlock()
  }

  private var active: Bool {
    condition.lock()
    defer { condition.unlock() }
    return enabled && foreground
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
      condition.lock()
      while !(enabled && foreground) { condition.wait() }
      condition.unlock()
      let semaphore = DispatchSemaphore(value: 0)
      let postedAt = CACurrentMediaTime()
      DispatchQueue.main.async { semaphore.signal() }
      if semaphore.wait(timeout: .now() + .milliseconds(finiteInt(thresholdMs))) == .timedOut {
        // Still blocked: wait for the end so the event has the full duration.
        semaphore.wait()
        let blockedMs = (CACurrentMediaTime() - postedAt) * 1000
        // A stall in the background is the system's, not a hang the user saw.
        if active {
          events.add([
            "type": "app_hang",
            "timestamp": OodleRumImpl.nowMs() - finiteInt64(blockedMs),
            "duration_ms": finiteInt64(blockedMs),
          ])
        }
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
  // Main thread only.
  private var started = false
  private var foreground = true
  /// A DispatchSource must be resumed as often as it was suspended.
  private var timerRunning = false

  func start() {
    DispatchQueue.main.async {
      if self.started { return }
      self.started = true
      if self.link == nil {
        let link = CADisplayLink(target: self, selector: #selector(self.onFrame(_:)))
        link.isPaused = true
        link.add(to: .main, forMode: .common)
        self.link = link
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(self.pause), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(self.resume), name: UIApplication.willEnterForegroundNotification, object: nil)
        self.timer = self.makeMemoryTimer()
        self.foreground = UIApplication.shared.applicationState != .background
      }
      self.apply()
    }
  }

  /// A new timer source is suspended until its first resume().
  private func makeMemoryTimer() -> DispatchSourceTimer {
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    t.schedule(deadline: .now(), repeating: 1.0)
    t.setEventHandler { [weak self] in self?.sampleMemory() }
    return t
  }

  /// The session is not sampled: its vitals would not be sent.
  func stop() {
    DispatchQueue.main.async {
      self.started = false
      self.apply()
    }
  }

  /// No frames are drawn in the background, and nothing is sent: the frame
  /// callback and the memory timer would only wake the CPU.
  @objc private func pause() {
    foreground = false
    apply()
  }

  @objc private func resume() {
    foreground = true
    apply()
  }

  /// Runs the display link and the memory timer only when started and in
  /// the foreground. Main thread.
  private func apply() {
    let on = started && foreground
    link?.isPaused = !on
    if let t = timer, on != timerRunning {
      if on { t.resume() } else { t.suspend() }
      timerRunning = on
    }
    if !on {
      lock.lock()
      lastFrame = 0
      lock.unlock()
    }
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
      // trap-free: a mach_msg_type_number_t (UInt32) fits in Int.
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
    var out: [String: Any] = ["duration_ms": finiteInt64(duration * 1000)]
    if frames > 0, frameTime > 0 { out["refresh_rate_avg"] = Double(frames) / frameTime }
    if minFps > 0 { out["refresh_rate_min"] = minFps }
    out["slow_frame_count"] = slow
    out["frozen_frame_count"] = frozen
    if memSamples > 0 { out["memory_avg_bytes"] = finiteInt64(memSum / Double(memSamples)) }
    if memMax > 0 { out["memory_max_bytes"] = finiteInt64(Double(memMax)) }
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
