package ai.oodle.rum

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.view.Choreographer
import android.view.Display
import com.facebook.react.bridge.UiThreadUtil
import org.json.JSONObject
import java.io.File

/**
 * Frame, memory and CPU statistics for the time since the last collect().
 * The JS side collects at view boundaries, so each view gets its own.
 */
object Vitals {
  /** A gap this long between frames is a frozen frame. */
  private const val FROZEN_NS = 700_000_000L
  /** Longer gaps mean the app was not drawing at all (background, sleep). */
  private const val PAUSE_NS = 5_000_000_000L
  private const val MEMORY_SAMPLE_MS = 1000L

  private val lock = Any()
  private var started = false
  private var expectedFrameNs = 16_666_667L
  private var lastFrameNs = 0L
  private var frames = 0L
  private var frameNsSum = 0L
  private var slow = 0
  private var frozen = 0
  private var windowStartNs = 0L
  private var windowFrames = 0
  private var minFps = 0.0
  private var memSum = 0.0
  private var memSamples = 0
  private var memMax = 0L
  private var intervalStartMs = 0L
  private var cpuStartTicks = -1L
  private var sampler: Handler? = null
  /** The memory sampler runs. Guarded by lock. */
  private var sampling = false
  /** No frames and no memory samples in the background. */
  @Volatile private var foreground = true

  private val sampleTask =
    object : Runnable {
      override fun run() {
        sampleMemory()
        synchronized(lock) { if (sampling) sampler?.postDelayed(this, MEMORY_SAMPLE_MS) }
      }
    }

  private val frameCallback =
    object : Choreographer.FrameCallback {
      override fun doFrame(frameTimeNanos: Long) {
        onFrame(frameTimeNanos)
        Choreographer.getInstance().postFrameCallback(this)
      }
    }

  fun start(context: Context): Boolean {
    synchronized(lock) {
      if (started) return true
      started = true
      intervalStartMs = SystemClock.uptimeMillis()
      cpuStartTicks = cpuTicks()
    }
    try {
      val dm = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
      val rate = dm?.getDisplay(Display.DEFAULT_DISPLAY)?.refreshRate ?: 60f
      if (rate > 1f) expectedFrameNs = (1_000_000_000L / rate).toLong()
    } catch (_: Throwable) {
    }
    if (foreground) begin()
    return true
  }

  /** The session is not sampled: its vitals would not be sent. */
  fun stop(): Boolean {
    synchronized(lock) {
      if (!started) return true
      started = false
    }
    halt()
    return true
  }

  /**
   * No frames are drawn in the background, and nothing is sent: the frame
   * callback and the memory sampler would only wake the CPU.
   */
  fun pause() {
    foreground = false
    halt()
  }

  fun resume() {
    foreground = true
    synchronized(lock) { if (!started) return }
    begin()
  }

  private fun begin() {
    UiThreadUtil.runOnUiThread {
      Choreographer.getInstance().removeFrameCallback(frameCallback)
      Choreographer.getInstance().postFrameCallback(frameCallback)
    }
    synchronized(lock) {
      if (sampling) return
      sampling = true
      val h =
        sampler ?: Handler(HandlerThread("oodle-rum-vitals").apply { start() }.looper).also { sampler = it }
      h.removeCallbacks(sampleTask)
      h.post(sampleTask)
    }
  }

  private fun halt() {
    UiThreadUtil.runOnUiThread {
      Choreographer.getInstance().removeFrameCallback(frameCallback)
      synchronized(lock) { lastFrameNs = 0L }
    }
    synchronized(lock) {
      sampling = false
      sampler?.removeCallbacks(sampleTask)
    }
  }

  private fun onFrame(nowNs: Long) {
    synchronized(lock) {
      val last = lastFrameNs
      lastFrameNs = nowNs
      if (last == 0L) {
        windowStartNs = nowNs
        return
      }
      val delta = nowNs - last
      if (delta <= 0 || delta > PAUSE_NS) {
        windowStartNs = nowNs
        windowFrames = 0
        return
      }
      frames++
      frameNsSum += delta
      if (delta > FROZEN_NS) frozen++ else if (delta > expectedFrameNs * 3 / 2) slow++
      windowFrames++
      val windowNs = nowNs - windowStartNs
      if (windowNs >= 1_000_000_000L) {
        val fps = windowFrames * 1e9 / windowNs
        if (minFps == 0.0 || fps < minFps) minFps = fps
        windowStartNs = nowNs
        windowFrames = 0
      }
    }
  }

  private fun residentBytes(): Long {
    val parts = File("/proc/self/statm").readText().trim().split(Regex("\\s+"))
    return parts[1].toLong() * Os.sysconf(OsConstants._SC_PAGESIZE)
  }

  private fun sampleMemory() {
    try {
      val rss = residentBytes()
      synchronized(lock) {
        memSum += rss.toDouble()
        memSamples++
        if (rss > memMax) memMax = rss
      }
    } catch (_: Throwable) {
    }
  }

  /** utime + stime of this process, in clock ticks. */
  private fun cpuTicks(): Long =
    try {
      val stat = File("/proc/self/stat").readText()
      // Fields after the command name, which is in parentheses and may hold spaces.
      val fields = stat.substring(stat.lastIndexOf(')') + 2).split(' ')
      fields[11].toLong() + fields[12].toLong()
    } catch (_: Throwable) {
      -1L
    }

  fun collect(): String {
    val json = JSONObject()
    synchronized(lock) {
      val now = SystemClock.uptimeMillis()
      val duration = now - intervalStartMs
      json.put("duration_ms", duration)
      if (frames > 0 && frameNsSum > 0) {
        json.put("refresh_rate_avg", frames * 1e9 / frameNsSum)
      }
      if (minFps > 0) json.put("refresh_rate_min", minFps)
      json.put("slow_frame_count", slow)
      json.put("frozen_frame_count", frozen)
      if (memSamples > 0) json.put("memory_avg_bytes", (memSum / memSamples).toLong())
      if (memMax > 0) json.put("memory_max_bytes", memMax)
      val ticks = cpuTicks()
      if (ticks >= 0 && cpuStartTicks >= 0 && duration > 0) {
        val hz = Os.sysconf(OsConstants._SC_CLK_TCK).takeIf { it > 0 } ?: 100L
        val cpuMs = (ticks - cpuStartTicks) * 1000.0 / hz
        json.put("cpu_ms_per_sec", cpuMs * 1000.0 / duration)
      }
      frames = 0
      frameNsSum = 0
      slow = 0
      frozen = 0
      minFps = 0.0
      windowFrames = 0
      windowStartNs = lastFrameNs
      memSum = 0.0
      memSamples = 0
      memMax = 0
      intervalStartMs = now
      cpuStartTicks = ticks
    }
    return json.toString()
  }
}
