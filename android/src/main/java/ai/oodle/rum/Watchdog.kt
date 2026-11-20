package ai.oodle.rum

import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Posts a task to the main thread and waits for it to run. A main thread
 * that does not run it within the threshold is an ANR. The main thread
 * stack is taken while it is still blocked, because afterwards it shows
 * only where the thread is now.
 */
object Watchdog {
  private const val POLL_MS = 100L
  private const val PAUSE_MS = 500L
  private const val MAX_STACK_FRAMES = 60
  @Volatile private var thread: Thread? = null
  /**
   * The system does not show an ANR for a stall in the background, and
   * the main thread of a background app can wait for the system on
   * purpose. Stalls are only recorded while the app is in the foreground.
   */
  @Volatile private var foreground = true

  fun pause() {
    foreground = false
  }

  fun resume() {
    foreground = true
  }

  @Synchronized
  fun start(thresholdMs: Long): Boolean {
    if (thread != null) return true
    val threshold = if (thresholdMs > 0) thresholdMs else 5000L
    val main = Handler(Looper.getMainLooper())
    val t =
      Thread({
        try {
          while (true) {
            val ran = AtomicBoolean(false)
            val postedAt = SystemClock.uptimeMillis()
            main.post { ran.set(true) }
            var stack: String? = null
            while (!ran.get()) {
              Thread.sleep(POLL_MS)
              val blocked = SystemClock.uptimeMillis() - postedAt
              // A paused debugger blocks the main thread on purpose.
              if (stack == null && blocked >= threshold && !Debug.isDebuggerConnected()) {
                stack = mainStack()
              }
            }
            if (stack != null && foreground) {
              val blocked = SystemClock.uptimeMillis() - postedAt
              val e = JSONObject()
              e.put("type", "anr")
              e.put("timestamp", System.currentTimeMillis() - blocked)
              e.put("duration_ms", blocked)
              e.put("stack", stack)
              NativeEvents.add(e)
            }
            Thread.sleep(PAUSE_MS)
          }
        } catch (_: InterruptedException) {
          // stopped
        }
      }, "oodle-rum-watchdog")
    t.isDaemon = true
    t.priority = Thread.MIN_PRIORITY
    t.start()
    thread = t
    return true
  }

  private fun mainStack(): String =
    Looper.getMainLooper().thread.stackTrace.take(MAX_STACK_FRAMES).joinToString("\n") { "at $it" }
}
