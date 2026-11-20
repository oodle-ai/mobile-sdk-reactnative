package ai.oodle.rum

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import org.json.JSONObject

/**
 * Reads why the previous process ended, from the system record. The JVM
 * handler cannot see a crash in C++ code (Hermes, Fabric, native
 * libraries) or an ANR that the system ended, but the system records
 * both. The JS side sends the result on the next start, as a crash.
 */
object ExitReasons {
  /** The newest exit already handled. Older exits are never sent again. */
  private const val LAST_EXIT_KEY = "last_exit_ts"
  private const val MAX_TRACE_CHARS = 16_000
  private const val MAX_TRACE_READ_BYTES = 256_000

  fun consume(context: Context, storage: Storage): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
    return consumeR(context, storage)
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun consumeR(context: Context, storage: Storage): String? {
    val am = context.getSystemService(ActivityManager::class.java) ?: return null
    val processName = context.applicationInfo.processName ?: context.packageName
    val exits = am.getHistoricalProcessExitReasons(context.packageName, 0, 16).filter { it.processName == processName }
    val last = storage.get(LAST_EXIT_KEY)?.toLongOrNull()
    val newest = exits.maxOfOrNull { it.timestamp } ?: 0L
    if (newest > (last ?: 0L)) storage.set(LAST_EXIT_KEY, newest.toString())
    // On the first start with the SDK, the exits are from before the SDK
    // was installed and have no session to attach to.
    if (last == null) return null
    val exit =
      exits
        .filter { it.timestamp > last }
        .filter { it.reason == ApplicationExitInfo.REASON_CRASH_NATIVE || it.reason == ApplicationExitInfo.REASON_ANR }
        .maxByOrNull { it.timestamp } ?: return null
    return toJson(exit).toString()
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun toJson(exit: ApplicationExitInfo): JSONObject {
    val json = JSONObject()
    json.put("timestamp", exit.timestamp)
    if (exit.reason == ApplicationExitInfo.REASON_ANR) {
      json.put("type", "ANR")
      json.put("message", exit.description?.takeIf { it.isNotBlank() } ?: "Application Not Responding: the system ended the app")
      json.put("stack", mainThreadTrace(exit))
      json.put("source", "anr")
    } else {
      val signal = signalName(exit.status)
      json.put("type", signal)
      json.put("message", "Native crash: $signal" + (exit.description?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: ""))
      json.put("stack", "")
      json.put("source", "native")
    }
    return json
  }

  /** The "main" thread block of the ANR trace, which shows where it was stuck. */
  @RequiresApi(Build.VERSION_CODES.R)
  private fun mainThreadTrace(exit: ApplicationExitInfo): String {
    val text =
      try {
        exit.traceInputStream?.use { input ->
          val buf = ByteArray(MAX_TRACE_READ_BYTES)
          var n = 0
          while (n < buf.size) {
            val r = input.read(buf, n, buf.size - n)
            if (r < 0) break
            n += r
          }
          String(buf, 0, n, Charsets.UTF_8)
        } ?: return ""
      } catch (_: Throwable) {
        return ""
      }
    val start = text.indexOf("\"main\"")
    val block =
      if (start < 0) {
        text
      } else {
        val end = text.indexOf("\n\n", start)
        if (end < 0) text.substring(start) else text.substring(start, end)
      }
    return if (block.length > MAX_TRACE_CHARS) block.substring(0, MAX_TRACE_CHARS) else block
  }

  private fun signalName(status: Int): String =
    when (status) {
      4 -> "SIGILL"
      5 -> "SIGTRAP"
      6 -> "SIGABRT"
      7 -> "SIGBUS"
      8 -> "SIGFPE"
      11 -> "SIGSEGV"
      else -> "Signal $status"
    }
}
