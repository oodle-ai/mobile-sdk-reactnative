package ai.oodle.rum

import android.content.Context
import android.os.Process
import android.util.Log
import org.json.JSONObject
import java.io.File
import kotlin.system.exitProcess

/**
 * Writes an uncaught JVM exception to disk before the process dies. The
 * JS side sends it on the next start, on the session that crashed.
 */
object CrashReporter {
  private const val CRASH_FILE = "crash.json"
  /** Written by the JS fatal error handler just before it rethrows. */
  private const val JS_CRASH_MARKER = "js_crash_marker"
  /** A JS fatal reaches native code shortly after the JS handler ran. */
  private const val JS_CRASH_WINDOW_MS = 10_000L
  private const val MAX_STACK_CHARS = 32_000

  @Volatile private var installed = false

  @Synchronized
  fun install(context: Context, storage: Storage): Boolean {
    if (installed) return true
    val dir = File(context.applicationContext.filesDir, Storage.DIR).apply { mkdirs() }
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      try {
        if (!alreadyReportedByJs(error, storage)) write(dir, thread, error)
      } catch (_: Throwable) {
        // the app's own handler must still run
      }
      if (previous != null) {
        previous.uncaughtException(thread, error)
      } else {
        Process.killProcess(Process.myPid())
        exitProcess(10)
      }
    }
    installed = true
    return true
  }

  /**
   * React Native turns a fatal JS error into a native JavascriptException.
   * The JS handler has already recorded that error with its JS stack, so
   * the native copy is skipped.
   */
  private fun alreadyReportedByJs(error: Throwable, storage: Storage): Boolean {
    var e: Throwable? = error
    while (e != null) {
      if (e.javaClass.name.endsWith("JavascriptException")) {
        val at = storage.get(JS_CRASH_MARKER)?.toLongOrNull() ?: return false
        return System.currentTimeMillis() - at < JS_CRASH_WINDOW_MS
      }
      e = e.cause
    }
    return false
  }

  private fun write(dir: File, thread: Thread, error: Throwable) {
    var root = error
    while (root.cause != null && root.cause !== root) root = root.cause!!
    val stack = Log.getStackTraceString(error).let { if (it.length > MAX_STACK_CHARS) it.substring(0, MAX_STACK_CHARS) else it }
    val json = JSONObject()
    json.put("timestamp", System.currentTimeMillis())
    json.put("type", error.javaClass.name)
    json.put("message", error.message ?: root.message ?: error.javaClass.simpleName)
    json.put("stack", "Thread: ${thread.name}\n$stack")
    json.put("source", "android")
    File(dir, CRASH_FILE).writeText(json.toString(), Charsets.UTF_8)
  }

  /**
   * The JVM crash file wins. The system exit record is read in both cases,
   * so that its newest timestamp moves on and an exit is sent once only.
   */
  fun consume(context: Context, storage: Storage): String? {
    val fromSystem = ExitReasons.consume(context.applicationContext, storage)
    val f = File(File(context.applicationContext.filesDir, Storage.DIR), CRASH_FILE)
    if (!f.exists()) return fromSystem
    val text = f.readText(Charsets.UTF_8)
    f.delete()
    return text
  }
}
