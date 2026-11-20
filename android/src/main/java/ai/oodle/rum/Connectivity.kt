package ai.oodle.rum

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

object Connectivity {
  fun current(context: Context): String {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return "unknown"
    val network = cm.activeNetwork ?: return "none"
    val caps = cm.getNetworkCapabilities(network) ?: return "none"
    return when {
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      else -> "other"
    }
  }
}
