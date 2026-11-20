package ai.oodle.rum

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.os.SystemClock
import org.json.JSONObject
import java.util.Locale

object DeviceInfo {
  fun collect(context: Context): JSONObject {
    val metrics = context.resources.displayMetrics
    val config = context.resources.configuration
    val json = JSONObject()
    json.put("brand", Build.MANUFACTURER.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.ROOT) else it.toString() })
    json.put("model", Build.MODEL)
    json.put("osName", "Android")
    json.put("osVersion", Build.VERSION.RELEASE ?: "")
    json.put("bundleId", context.packageName)
    try {
      val info =
        if (Build.VERSION.SDK_INT >= 33) {
          context.packageManager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
        } else {
          @Suppress("DEPRECATION")
          context.packageManager.getPackageInfo(context.packageName, 0)
        }
      json.put("appVersion", info.versionName ?: "")
      val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
      json.put("appBuild", code.toString())
    } catch (_: Exception) {
      json.put("appVersion", "")
      json.put("appBuild", "")
    }
    json.put("deviceType", if (config.smallestScreenWidthDp >= 600) "tablet" else "mobile")
    json.put("screenWidth", metrics.widthPixels / metrics.density)
    json.put("screenHeight", metrics.heightPixels / metrics.density)
    json.put("scale", metrics.density.toDouble())
    json.put("locale", Locale.getDefault().toLanguageTag())
    json.put("processStartMs", processStartMs())
    return json
  }

  /** Wall clock time the process started. */
  fun processStartMs(): Long {
    val sinceStart = SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()
    return System.currentTimeMillis() - sinceStart
  }
}
