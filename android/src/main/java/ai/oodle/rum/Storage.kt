package ai.oodle.rum

import android.content.Context
import java.io.File
import java.util.concurrent.Executors

/**
 * Small key-value files for SDK state (session, unsent events). Writes go
 * through a temporary file and a rename, so a process that dies mid-write
 * leaves the previous value instead of a torn one.
 *
 * Every write takes a version number for its key. A background write
 * that is older than the last write of its key is skipped, so a
 * synchronous write on the fatal error path is never replaced by an
 * older background write.
 */
class Storage(context: Context) {
  private val dir = File(context.filesDir, DIR).apply { mkdirs() }

  private fun file(key: String) = File(dir, key.replace(Regex("[^A-Za-z0-9_.-]"), "_"))

  fun get(key: String): String? =
    synchronized(LOCK) {
      val f = file(key)
      if (f.exists()) f.readText(Charsets.UTF_8) else null
    }

  fun set(key: String, value: String): Boolean =
    synchronized(LOCK) {
      bump(key)
      write(key, value)
    }

  /** Writes on a background thread. [done] gets the result on that thread. */
  fun setAsync(key: String, value: String, done: (Boolean) -> Unit) {
    val version = synchronized(LOCK) { bump(key) }
    EXECUTOR.execute {
      val ok =
        try {
          synchronized(LOCK) { if (VERSIONS[versionKey(key)] != version) true else write(key, value) }
        } catch (_: Throwable) {
          false
        }
      done(ok)
    }
  }

  fun remove(key: String): Boolean =
    synchronized(LOCK) {
      bump(key)
      file(key).delete()
    }

  fun modifiedAt(key: String): Long = file(key).let { if (it.exists()) it.lastModified() else 0L }

  private fun versionKey(key: String) = file(key).path

  private fun bump(key: String): Long {
    val k = versionKey(key)
    val next = (VERSIONS[k] ?: 0L) + 1
    VERSIONS[k] = next
    return next
  }

  private fun write(key: String, value: String): Boolean {
    val target = file(key)
    val tmp = File(dir, target.name + ".tmp")
    tmp.writeText(value, Charsets.UTF_8)
    return tmp.renameTo(target) || run {
      target.delete()
      tmp.renameTo(target)
    }
  }

  companion object {
    const val DIR = "oodle-rum"
    // Shared by all instances: the crash handler and the module can hold
    // different Storage objects for the same files.
    private val LOCK = Any()
    private val VERSIONS = HashMap<String, Long>()
    private val EXECUTOR =
      Executors.newSingleThreadExecutor { r -> Thread(r, "oodle-rum-storage").apply { isDaemon = true } }
  }
}
