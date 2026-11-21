package ai.oodle.rum

import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Posts a task to the main thread and waits for it to run. A main thread
 * that does not run it within the threshold is an ANR. The main thread
 * stack is taken while it is still blocked, because afterwards it shows
 * only where the thread is now.
 *
 * The thread waits, and does not wake, while the app is in the background
 * or the session is not sampled (stop()).
 */
object Watchdog {
  private const val PAUSE_MS = 500L
  private const val MAX_STACK_FRAMES = 60
  private val gate = Object()
  private var thread: Thread? = null
  @Volatile private var thresholdMs = 5000L
  /** start() was called and stop() was not called after it. */
  @Volatile private var enabled = false
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
    wake()
  }

  /** The session is not sampled: its stalls would not be sent. */
  fun stop(): Boolean {
    enabled = false
    return true
  }

  private fun wake() {
    synchronized(gate) { gate.notifyAll() }
  }

  @Synchronized
  fun start(threshold: Long): Boolean {
    thresholdMs = if (threshold > 0) threshold else 5000L
    enabled = true
    wake()
    if (thread != null) return true
    val main = Handler(Looper.getMainLooper())
    val t =
      Thread({
        try {
          while (true) {
            synchronized(gate) {
              while (!(enabled && foreground)) gate.wait()
            }
            val ran = CountDownLatch(1)
            val postedAt = SystemClock.uptimeMillis()
            main.post { ran.countDown() }
            var stack: String? = null
            // One wait to the threshold, not a poll every 100 ms.
            if (!ran.await(thresholdMs, TimeUnit.MILLISECONDS)) {
              // A paused debugger blocks the main thread on purpose.
              if (!Debug.isDebuggerConnected()) stack = mainStack()
              ran.await()
            }
            if (stack != null && foreground && enabled) {
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
