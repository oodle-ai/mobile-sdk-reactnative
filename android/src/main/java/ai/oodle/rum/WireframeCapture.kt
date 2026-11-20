package ai.oodle.rum

import android.app.Activity
import android.graphics.Color
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.SystemClock
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.Gravity
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.WebView
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.ScrollView
import android.widget.TextView
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.style.BorderRadiusProp
import com.facebook.react.uimanager.style.LogicalEdge
import org.json.JSONArray
import org.json.JSONObject
import java.util.WeakHashMap

/**
 * Walks the visible view tree and describes each view that draws
 * something as a wireframe: a box with a position, colors, and text.
 * The JS side turns wireframes into replay events and applies privacy
 * masking. Must run on the main thread.
 */
object WireframeCapture {
  private const val PRIVACY_PREFIX = "oodle-privacy-"
  /** Walks longer than this stop early, to keep frames from dropping. */
  private const val TIME_BUDGET_MS = 40L
  private const val UNCHANGED = "{\"unchanged\":true}"

  private class Walk(
    val density: Float,
    val baseX: Int,
    val baseY: Int,
    val maxNodes: Int,
    val deadline: Long,
  ) {
    val nodes = JSONArray()
    var truncated = false
    val loc = IntArray(2)
  }

  /**
   * Draw passes of the tracked windows. When no window drew since the last
   * walk, the screen is the same, so the walk and the transfer to JS are
   * skipped. This keeps an idle screen from costing main thread time.
   */
  private var drawTick = 0L
  private val tracked = WeakHashMap<View, ViewTreeObserver.OnDrawListener>()
  private var lastSignature: String? = null

  private fun track(roots: List<View>) {
    for (root in roots) {
      if (tracked.containsKey(root)) continue
      val listener = ViewTreeObserver.OnDrawListener { drawTick++ }
      try {
        root.viewTreeObserver.addOnDrawListener(listener)
        tracked[root] = listener
      } catch (_: Throwable) {
        // A dead observer: the root is walked every time.
      }
    }
  }

  fun capture(activity: Activity?, options: JSONObject): String {
    val roots = rootViews(activity)
    val base = activity?.window?.decorView ?: roots.firstOrNull()
    val out = JSONObject()
    if (base == null || base.width == 0) {
      lastSignature = null
      out.put("width", 0).put("height", 0).put("nodes", JSONArray())
      return out.toString()
    }
    track(roots)
    val signature =
      roots.joinToString(",") { System.identityHashCode(it).toString() } +
        "|${base.width}x${base.height}|$drawTick"
    if (options.optBoolean("skipUnchanged", false) && signature == lastSignature) {
      return UNCHANGED
    }
    lastSignature = signature
    val density = base.resources.displayMetrics.density
    val baseLoc = IntArray(2)
    base.getLocationOnScreen(baseLoc)
    val walk =
      Walk(
        density,
        baseLoc[0],
        baseLoc[1],
        options.optInt("maxNodes", 2000),
        SystemClock.uptimeMillis() + TIME_BUDGET_MS,
      )
    val screen = RectF(0f, 0f, base.width.toFloat(), base.height.toFloat())
    for (root in roots) walk(root, walk, screen, 1f, null)
    out.put("width", round(base.width / density))
    out.put("height", round(base.height / density))
    out.put("nodes", walk.nodes)
    if (walk.truncated) out.put("truncated", true)
    return out.toString()
  }

  /**
   * The activity window plus any dialog windows (React Native's Modal is a
   * dialog), in the order they were added, which is back to front.
   */
  @Suppress("UNCHECKED_CAST")
  private fun rootViews(activity: Activity?): List<View> {
    val decor = activity?.window?.decorView
    try {
      val wmg = Class.forName("android.view.WindowManagerGlobal")
      val instance = wmg.getMethod("getInstance").invoke(null)
      val field = wmg.getDeclaredField("mViews").apply { isAccessible = true }
      val views = ArrayList(field.get(instance) as List<View>)
      val visible = views.filter { it.isAttachedToWindow && it.windowVisibility == View.VISIBLE && it.width > 0 }
      if (visible.isNotEmpty() && (decor == null || visible.contains(decor))) return visible
    } catch (_: Throwable) {
      // Hidden API not reachable: record the activity window only.
    }
    return listOfNotNull(decor)
  }

  private fun walk(view: View, w: Walk, clip: RectF, parentAlpha: Float, privacy: String?) {
    if (w.nodes.length() >= w.maxNodes || SystemClock.uptimeMillis() > w.deadline) {
      w.truncated = true
      return
    }
    if (view.visibility != View.VISIBLE || view.width == 0 || view.height == 0) return
    val alpha = parentAlpha * view.alpha
    if (alpha <= 0.01f) return
    view.getLocationOnScreen(w.loc)
    val x = (w.loc[0] - w.baseX).toFloat()
    val y = (w.loc[1] - w.baseY).toFloat()
    val rect = RectF(x, y, x + view.width * view.scaleX, y + view.height * view.scaleY)
    val visible = RectF(rect)
    if (!visible.intersect(clip)) return

    var pv = privacy
    val nativeId = nativeId(view)
    if (nativeId != null && nativeId.startsWith(PRIVACY_PREFIX)) {
      when (nativeId.substring(PRIVACY_PREFIX.length)) {
        "hidden" -> {
          w.nodes.put(box(view, "h", rect, visible, w, alpha))
          return
        }
        "mask" -> pv = "mask"
        "allow" -> pv = "allow"
      }
    }

    describe(view, rect, visible, w, alpha, pv)?.let { w.nodes.put(it) }

    if (view is ViewGroup && !isLeaf(view)) {
      val childClip = if (clipsChildren(view)) visible else clip
      for (i in 0 until view.childCount) {
        walk(view.getChildAt(i), w, childClip, alpha, pv)
      }
    }
  }

  private fun isLeaf(view: ViewGroup): Boolean = view is WebView

  private fun nativeId(view: View): String? =
    try {
      view.getTag(com.facebook.react.R.id.view_tag_native_id) as? String
    } catch (_: Throwable) {
      null
    }

  private fun clipsChildren(view: ViewGroup): Boolean {
    if (view is ScrollView || view is HorizontalScrollView) return true
    if (view.javaClass.name.contains("ScrollView")) return true
    if (view.clipChildren) return true
    // React Native views keep clipChildren off and clip for overflow: hidden.
    return try {
      val overflow = view.javaClass.getMethod("getOverflow").invoke(view)
      overflow != null && overflow.toString().lowercase().let { it.contains("hidden") || it.contains("scroll") }
    } catch (_: Throwable) {
      false
    }
  }

  private fun describe(view: View, rect: RectF, visible: RectF, w: Walk, alpha: Float, pv: String?): JSONObject? {
    val bg = backgroundColor(view)
    val borderWidth = borderWidth(view)
    return when {
      view is EditText -> {
        val n = box(view, "in", rect, visible, w, alpha)
        styleBox(n, view, bg, borderWidth, w)
        n.put("tx", view.text?.toString() ?: "")
        view.hint?.toString()?.takeIf { it.isNotEmpty() }?.let { n.put("ph", it) }
        textStyle(n, view, w)
        if (isSensitive(view)) n.put("sen", true)
        pv?.let { n.put("pv", it) }
        n
      }
      view is CompoundButton && isSwitch(view) -> {
        val n = box(view, "sw", rect, visible, w, alpha)
        n.put("on", view.isChecked)
        n
      }
      view is TextView -> {
        val text = view.text?.toString() ?: ""
        if (isIconGlyph(text)) {
          return box(view, "i", rect, visible, w, alpha)
        }
        if (text.isBlank() && !hasPaint(bg, borderWidth)) return null
        val n = box(view, if (text.isBlank()) "s" else "t", rect, visible, w, alpha)
        styleBox(n, view, bg, borderWidth, w)
        if (text.isNotBlank()) {
          n.put("tx", text)
          textStyle(n, view, w)
          pv?.let { n.put("pv", it) }
        }
        n
      }
      view.javaClass.simpleName == "PreparedLayoutTextView" -> preparedLayoutText(view, rect, visible, w, alpha, pv, bg, borderWidth)
      view is ImageView -> box(view, "i", rect, visible, w, alpha).also { styleBox(it, view, null, 0f, w) }
      view is WebView -> box(view, "wv", rect, visible, w, alpha)
      view is SurfaceView || view is TextureView -> box(view, "p", rect, visible, w, alpha)
      hasPaint(bg, borderWidth) -> box(view, "s", rect, visible, w, alpha).also { styleBox(it, view, bg, borderWidth, w) }
      else -> null
    }
  }

  private fun isSwitch(view: CompoundButton): Boolean = view.javaClass.name.contains("Switch", ignoreCase = true)

  private fun hasPaint(bg: Int?, borderWidth: Float): Boolean = (bg != null && Color.alpha(bg) > 0) || borderWidth > 0f

  /** Icon fonts draw glyphs from the Unicode private use area; text would show boxes. */
  private fun isIconGlyph(text: String): Boolean {
    if (text.isEmpty() || text.length > 4) return false
    return text.all { it.code in 0xE000..0xF8FF || Character.isSurrogate(it) }
  }

  private fun box(view: View, kind: String, rect: RectF, visible: RectF, w: Walk, alpha: Float): JSONObject {
    val d = w.density
    val n = JSONObject()
    n.put("id", System.identityHashCode(view))
    n.put("k", kind)
    n.put("x", round(rect.left / d))
    n.put("y", round(rect.top / d))
    n.put("w", round(rect.width() / d))
    n.put("h", round(rect.height() / d))
    if (alpha < 0.99f) n.put("o", round(alpha))
    if (visible != rect) {
      val insets = JSONArray()
      insets.put(round((visible.top - rect.top) / d))
      insets.put(round((rect.right - visible.right) / d))
      insets.put(round((rect.bottom - visible.bottom) / d))
      insets.put(round((visible.left - rect.left) / d))
      n.put("c", insets)
    }
    return n
  }

  private fun styleBox(n: JSONObject, view: View, bg: Int?, borderWidth: Float, w: Walk) {
    if (bg != null && Color.alpha(bg) > 0) n.put("bg", css(bg))
    if (borderWidth > 0f) {
      n.put("bw", round(borderWidth))
      borderColor(view)?.let { n.put("bc", css(it)) }
    }
    val r = radius(view, n.optDouble("w", 0.0).toFloat(), w)
    if (r > 0f) n.put("r", round(r))
  }

  private fun textStyle(n: JSONObject, view: TextView, w: Walk) {
    n.put("tc", css(view.currentTextColor))
    n.put("fs", round(view.textSize / w.density))
    val tf = view.typeface
    val weight = when {
      tf == null -> 400
      Build.VERSION.SDK_INT >= 28 -> tf.weight
      tf.isBold -> 700
      else -> 400
    }
    if (weight != 400) n.put("fw", weight)
    when (view.gravity and Gravity.HORIZONTAL_GRAVITY_MASK) {
      Gravity.CENTER_HORIZONTAL -> n.put("ta", "center")
      Gravity.RIGHT, Gravity.END -> n.put("ta", "right")
    }
  }

  /** React Native's newer text view keeps its text in a prepared Layout. */
  private fun preparedLayoutText(
    view: View,
    rect: RectF,
    visible: RectF,
    w: Walk,
    alpha: Float,
    pv: String?,
    bg: Int?,
    borderWidth: Float,
  ): JSONObject? =
    try {
      val getter = view.javaClass.methods.first { it.name.startsWith("getPreparedLayout") && it.parameterCount == 0 }
      val prepared = getter.invoke(view) ?: return null
      val layout = prepared.javaClass.getMethod("getLayout").invoke(prepared) as android.text.Layout
      val text = layout.text?.toString() ?: ""
      val n = box(view, if (text.isBlank()) "s" else "t", rect, visible, w, alpha)
      styleBox(n, view, bg, borderWidth, w)
      if (text.isNotBlank()) {
        n.put("tx", text)
        n.put("tc", css(layout.paint.color))
        n.put("fs", round(layout.paint.textSize / w.density))
        when (layout.alignment) {
          android.text.Layout.Alignment.ALIGN_CENTER -> n.put("ta", "center")
          android.text.Layout.Alignment.ALIGN_OPPOSITE -> n.put("ta", "right")
          else -> {}
        }
        pv?.let { n.put("pv", it) }
      }
      n
    } catch (_: Throwable) {
      if (hasPaint(bg, borderWidth)) box(view, "s", rect, visible, w, alpha) else null
    }

  private fun isSensitive(view: EditText): Boolean {
    if (view.transformationMethod is PasswordTransformationMethod) return true
    val type = view.inputType
    val cls = type and InputType.TYPE_MASK_CLASS
    val variation = type and InputType.TYPE_MASK_VARIATION
    return when (cls) {
      InputType.TYPE_CLASS_TEXT ->
        variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
          variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
          variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
          variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS ||
          variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS ||
          variation == InputType.TYPE_TEXT_VARIATION_POSTAL_ADDRESS
      InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
      InputType.TYPE_CLASS_PHONE -> true
      else -> false
    }
  }

  private fun backgroundColor(view: View): Int? {
    try {
      BackgroundStyleApplicator.getBackgroundColor(view)?.let { return it }
    } catch (_: Throwable) {
    }
    return when (val bg = view.background) {
      is ColorDrawable -> bg.color
      is GradientDrawable -> bg.color?.defaultColor
      else -> null
    }
  }

  private fun borderWidth(view: View): Float =
    try {
      BackgroundStyleApplicator.getBorderWidth(view, LogicalEdge.ALL)
        ?: BackgroundStyleApplicator.getBorderWidth(view, LogicalEdge.TOP)
        ?: 0f
    } catch (_: Throwable) {
      0f
    }

  private fun borderColor(view: View): Int? =
    try {
      BackgroundStyleApplicator.getBorderColor(view, LogicalEdge.ALL)
        ?: BackgroundStyleApplicator.getBorderColor(view, LogicalEdge.TOP)
    } catch (_: Throwable) {
      null
    }

  private fun radius(view: View, widthDp: Float, w: Walk): Float {
    try {
      val r =
        BackgroundStyleApplicator.getBorderRadius(view, BorderRadiusProp.BORDER_RADIUS)
          ?: BackgroundStyleApplicator.getBorderRadius(view, BorderRadiusProp.BORDER_TOP_LEFT_RADIUS)
      if (r != null) return r.resolve(widthDp)
    } catch (_: Throwable) {
    }
    val bg = view.background
    if (bg is GradientDrawable && Build.VERSION.SDK_INT >= 24) {
      return bg.cornerRadius / w.density
    }
    return 0f
  }

  /** ARGB int to CSS #rrggbbaa. */
  private fun css(color: Int): String =
    String.format("#%02x%02x%02x%02x", Color.red(color), Color.green(color), Color.blue(color), Color.alpha(color))

  private fun round(v: Float): Double = Math.round(v * 10.0) / 10.0
}
