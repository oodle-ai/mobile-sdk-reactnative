package ai.oodle.rum

import android.util.Log

/*
 * The boundary between the app and the SDK in native code. An exception
 * that leaves SDK code on any thread ends the app. Each callback that the
 * platform calls (a thread, a posted block, a frame callback, a lifecycle
 * method) runs its body in safely { } or safe(fallback) { }.
 * test/guard.test.ts fails on a callback that does not. A callback that
 * must run other code outside the guard has a comment
 * "// unguarded: <reason>" on the line before it.
 */

private const val TAG = "OodleRum"

/** Runs SDK code. An exception in it is logged, and gives [fallback]. */
internal inline fun <T> safe(fallback: T, block: () -> T): T =
  try {
    block()
  } catch (t: Throwable) {
    logInternalError(t)
    fallback
  }

/** Runs SDK code that gives nothing. An exception in it is logged. */
internal inline fun safely(block: () -> Unit) {
  safe(Unit, block)
}

internal fun logInternalError(t: Throwable) {
  try {
    Log.w(TAG, "Internal error; the SDK goes on", t)
  } catch (_: Throwable) {
    // A log call must not throw out of the guard.
  }
}
