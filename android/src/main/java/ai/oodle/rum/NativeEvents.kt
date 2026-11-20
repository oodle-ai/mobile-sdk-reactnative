package ai.oodle.rum

import org.json.JSONArray
import org.json.JSONObject

/** Events found by native code (ANRs), held until JS collects them. */
object NativeEvents {
  private const val MAX = 50
  private val events = ArrayList<JSONObject>()

  @Synchronized
  fun add(event: JSONObject) {
    if (events.size >= MAX) events.removeAt(0)
    events.add(event)
  }

  @Synchronized
  fun drain(): String {
    val out = JSONArray()
    for (e in events) out.put(e)
    events.clear()
    return out.toString()
  }
}
