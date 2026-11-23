package ai.oodle.rum

import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import org.json.JSONObject

/**
 * Native half of the SDK. Every method returns a fallback instead of
 * throwing: a failure in monitoring code must never reach the app.
 */
class OodleRumModule(reactContext: ReactApplicationContext) :
  NativeOodleRumSpec(reactContext), LifecycleEventListener {
  private val storage = Storage(reactContext)

  init {
    reactContext.addLifecycleEventListener(this)
  }

  override fun onHostResume() {
    Vitals.resume()
    Watchdog.resume()
  }

  override fun onHostPause() {
    Vitals.pause()
    Watchdog.pause()
  }

  override fun onHostDestroy() {
    Vitals.pause()
    Watchdog.pause()
  }

  override fun invalidate() {
    reactApplicationContext.removeLifecycleEventListener(this)
    super.invalidate()
  }

  override fun getName(): String = NAME

  override fun getDeviceInfo(): String =
    safe("{}") { DeviceInfo.collect(reactApplicationContext).toString() }

  override fun storageGet(key: String): String? = safe(null) { storage.get(key) }

  override fun storageSet(key: String, value: String): Boolean = safe(false) { storage.set(key, value) }

  override fun storageSetAsync(key: String, value: String, promise: Promise) {
    try {
      storage.setAsync(key, value) { ok -> promise.resolve(ok) }
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  override fun storageRemove(key: String): Boolean = safe(false) { storage.remove(key) }

  override fun enableCrashReporting(): Boolean =
    safe(false) { CrashReporter.install(reactApplicationContext, storage) }

  override fun consumePendingCrash(): String? = safe(null) { CrashReporter.consume(reactApplicationContext, storage) }

  override fun startWatchdog(thresholdMs: Double): Boolean = safe(false) { Watchdog.start(thresholdMs.toLong()) }

  override fun stopWatchdog(): Boolean = safe(false) { Watchdog.stop() }

  override fun drainNativeEvents(): String = safe("[]") { NativeEvents.drain() }

  override fun startVitals(): Boolean = safe(false) { Vitals.start(reactApplicationContext) }

  override fun stopVitals(): Boolean = safe(false) { Vitals.stop() }

  override fun collectVitals(): String = safe("{}") { Vitals.collect() }

  override fun getConnectivity(): String = safe("unknown") { Connectivity.current(reactApplicationContext) }

  override fun captureWireframes(optionsJson: String, promise: Promise) {
    val options = safe(JSONObject()) { JSONObject(optionsJson) }
    UiThreadUtil.runOnUiThread {
      val reject = { t: Throwable -> promise.reject("capture_failed", t.message ?: t.javaClass.name, t) }
      try {
        WireframeCapture.capture(reactApplicationContext.currentActivity, options, { promise.resolve(it) }, reject)
      } catch (t: Throwable) {
        reject(t)
      }
    }
  }

  /**
   * Not used on Android: React Native compresses a string body with
   * Content-Encoding: gzip off the JS thread there (see transport.ts).
   */
  override fun postGzip(url: String, headersJson: String, body: String, promise: Promise) {
    promise.reject("unsupported", "postGzip is used on iOS only")
  }

  private inline fun <T> safe(fallback: T, block: () -> T): T =
    try {
      block()
    } catch (t: Throwable) {
      fallback
    }

  companion object {
    const val NAME = "OodleRum"
  }
}
