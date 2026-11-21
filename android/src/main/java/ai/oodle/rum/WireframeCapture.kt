package ai.oodle.rum

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.RectF
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.method.PasswordTransformationMethod
import android.text.style.CharacterStyle
import android.util.Base64
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
import java.io.ByteArrayOutputStream
import java.lang.reflect.Method
import java.util.WeakHashMap
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Walks the visible view tree and describes each view that draws
 * something as a wireframe: a box with a position, colors, and text.
 * The JS side turns wireframes into replay events and applies privacy
 * masking. Must run on the main thread.
 */
object WireframeCapture {
  private const val PRIVACY_PREFIX = "oodle-privacy-"
  /**
   * Main thread time of one slice of a walk. The walk gives the main
   * thread back between slices, so frames can draw while it goes on.
   */
  private const val SLICE_MS = 4L
  /** Main thread time of all slices of one walk. A longer walk stops ("truncated"). */
  private const val WALK_BUDGET_MS = 40L
  /** A walk that takes longer than this, in slices, stops. The screen keeps changing. */
  private const val WALK_MAX_WALL_MS = 1_000L
  private const val UNCHANGED = "{\"unchanged\":true}"

  private val main = Handler(Looper.getMainLooper())
  /** Serializes walk results off the main thread. */
  private val worker =
    Executors.newSingleThreadExecutor { r ->
      Thread(r, "oodle-rum-replay").apply {
        isDaemon = true
        priority = Thread.MIN_PRIORITY
      }
    }

  /** A view still to visit, with what its parents give it. */
  private class Item(val view: View, val clip: RectF, val alpha: Float, val privacy: String?)

  private class Walk(
    val density: Float,
    val baseX: Int,
    val baseY: Int,
    val maxNodes: Int,
    val startedAt: Long,
  ) {
    val nodes = JSONArray()
    var truncated = false
    val loc = IntArray(2)
    /** Views to visit, last on top. Children go on in reverse, so the walk is in draw order. */
    val stack = ArrayDeque<Item>()
    /** Main thread time of the slices so far. */
    var spentMs = 0L
  }

  /** True while a walk runs. Main thread only. */
  private var busy = false

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

  /**
   * Starts a walk on the main thread. The walk runs in slices of SLICE_MS
   * on the main thread, and the result is serialized on a worker thread.
   * `resolve` or `reject` is called once, on any thread.
   */
  fun capture(activity: Activity?, options: JSONObject, resolve: (String) -> Unit, reject: (Throwable) -> Unit) {
    if (busy) {
      // The JS side waits for each walk; this is only a guard.
      resolve(UNCHANGED)
      return
    }
    val roots = rootViews(activity)
    val base = activity?.window?.decorView ?: roots.firstOrNull()
    if (base == null || base.width == 0) {
      lastSignature = null
      resolve(JSONObject().put("width", 0).put("height", 0).put("nodes", JSONArray()).toString())
      return
    }
    track(roots)
    val signature =
      roots.joinToString(",") { System.identityHashCode(it).toString() } +
        "|${base.width}x${base.height}|$drawTick"
    if (options.optBoolean("skipUnchanged", false) && signature == lastSignature) {
      resolve(UNCHANGED)
      return
    }
    lastSignature = signature
    val density = base.resources.displayMetrics.density
    val baseLoc = IntArray(2)
    base.getLocationOnScreen(baseLoc)
    val walk = Walk(density, baseLoc[0], baseLoc[1], options.optInt("maxNodes", 2000), SystemClock.uptimeMillis())
    val screen = RectF(0f, 0f, base.width.toFloat(), base.height.toFloat())
    for (root in roots.asReversed()) walk.stack.addLast(Item(root, screen, 1f, null))
    val width = round(base.width / density)
    val height = round(base.height / density)
    busy = true
    step(walk, width, height, resolve, reject)
  }

  private fun step(w: Walk, width: Double, height: Double, resolve: (String) -> Unit, reject: (Throwable) -> Unit) {
    try {
      val sliceStart = SystemClock.uptimeMillis()
      while (w.stack.isNotEmpty()) {
        val now = SystemClock.uptimeMillis()
        if (w.nodes.length() >= w.maxNodes ||
          w.spentMs + (now - sliceStart) > WALK_BUDGET_MS ||
          now - w.startedAt > WALK_MAX_WALL_MS
        ) {
          w.truncated = true
          break
        }
        if (now - sliceStart >= SLICE_MS) {
          w.spentMs += now - sliceStart
          main.post { step(w, width, height, resolve, reject) }
          return
        }
        visit(w.stack.removeLast(), w)
      }
      busy = false
      val out = JSONObject()
      out.put("width", width)
      out.put("height", height)
      out.put("nodes", w.nodes)
      if (w.truncated) out.put("truncated", true)
      worker.execute {
        val text =
          try {
            out.toString()
          } catch (t: Throwable) {
            reject(t)
            return@execute
          }
        resolve(text)
      }
    } catch (t: Throwable) {
      busy = false
      lastSignature = null
      reject(t)
    }
  }

  /**
   * The activity window plus any dialog windows (React Native's Modal is a
   * dialog), in the order they were added, which is back to front.
   */
  /** WindowManagerGlobal and its list of window views, found once. */
  private val windowViews: Pair<Any, java.lang.reflect.Field>? by lazy {
    try {
      val wmg = Class.forName("android.view.WindowManagerGlobal")
      val instance = wmg.getMethod("getInstance").invoke(null)
      val field = wmg.getDeclaredField("mViews").apply { isAccessible = true }
      if (instance != null) Pair(instance, field) else null
    } catch (_: Throwable) {
      null
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun rootViews(activity: Activity?): List<View> {
    val decor = activity?.window?.decorView
    try {
      val (instance, field) = windowViews ?: return listOfNotNull(decor)
      val views = ArrayList(field.get(instance) as List<View>)
      val visible = views.filter { it.isAttachedToWindow && it.windowVisibility == View.VISIBLE && it.width > 0 }
      if (visible.isNotEmpty() && (decor == null || visible.contains(decor))) return visible
    } catch (_: Throwable) {
      // Hidden API not reachable: record the activity window only.
    }
    return listOfNotNull(decor)
  }

  private fun visit(item: Item, w: Walk) {
    val view = item.view
    // The walk runs in slices: a view can leave the screen between them.
    if (!view.isAttachedToWindow) return
    if (view.visibility != View.VISIBLE || view.width == 0 || view.height == 0) return
    val alpha = item.alpha * view.alpha
    if (alpha <= 0.01f) return
    view.getLocationOnScreen(w.loc)
    val x = (w.loc[0] - w.baseX).toFloat()
    val y = (w.loc[1] - w.baseY).toFloat()
    val rect = RectF(x, y, x + view.width * view.scaleX, y + view.height * view.scaleY)
    val visible = RectF(rect)
    if (!visible.intersect(item.clip)) return

    var pv = item.privacy
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
      val childClip = if (clipsChildren(view)) visible else item.clip
      for (i in view.childCount - 1 downTo 0) {
        val child = view.getChildAt(i) ?: continue
        w.stack.addLast(Item(child, childClip, alpha, pv))
      }
    }
  }

  /**
   * What the walk needs to know about a view class, found once per class.
   * Reflection on each view of each walk was a large part of its time, and
   * getMethod throws for every class without the method.
   */
  private class ClassInfo(cls: Class<*>) {
    val name: String = cls.name
    /** A react-native-svg drawing (see isVector). */
    val vector = name == "com.horcrux.svg.SvgView"
    val scroll = name.contains("ScrollView")
    val preparedText = cls.simpleName == "PreparedLayoutTextView"
    val switch = name.contains("Switch", ignoreCase = true)
    /** React Native's getOverflow(), or null when the class has none. */
    val overflow: Method? =
      try {
        cls.getMethod("getOverflow")
      } catch (_: Throwable) {
        null
      }
    /** The getter of a PreparedLayoutTextView's prepared layout. */
    val preparedLayout: Method? =
      if (!preparedText) {
        null
      } else {
        try {
          cls.methods.firstOrNull { it.name.startsWith("getPreparedLayout") && it.parameterCount == 0 }
        } catch (_: Throwable) {
          null
        }
      }
  }

  /** Main thread only. Classes stay loaded, so the cache does not grow without end. */
  private val classes = HashMap<Class<*>, ClassInfo>()
  /** getLayout() of each prepared layout class. */
  private val layoutGetters = HashMap<Class<*>, Method?>()

  private fun info(view: View): ClassInfo = classes.getOrPut(view.javaClass) { ClassInfo(view.javaClass) }

  private fun isLeaf(view: ViewGroup): Boolean = view is WebView || isVector(view)

  /**
   * A react-native-svg drawing. Its shapes are views of their own, but the
   * SvgView draws them all, so it is captured as one picture.
   */
  private fun isVector(view: View): Boolean = info(view).vector

  private fun nativeId(view: View): String? =
    try {
      view.getTag(com.facebook.react.R.id.view_tag_native_id) as? String
    } catch (_: Throwable) {
      null
    }

  private fun clipsChildren(view: ViewGroup): Boolean {
    if (view is ScrollView || view is HorizontalScrollView) return true
    val info = info(view)
    if (info.scroll) return true
    if (view.clipChildren) return true
    // React Native views keep clipChildren off and clip for overflow: hidden.
    val getter = info.overflow ?: return false
    return try {
      val overflow = getter.invoke(view)
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
          val color = view.layout?.let { spanPaint(it).color } ?: view.currentTextColor
          return vector(view, rect, visible, w, alpha, pv, "$text|$color")
        }
        if (text.isBlank() && !hasPaint(bg, borderWidth)) return null
        val n = box(view, if (text.isBlank()) "s" else "t", rect, visible, w, alpha)
        styleBox(n, view, bg, borderWidth, w)
        if (text.isNotBlank()) {
          val layout = view.layout
          if (layout != null && layout.lineCount > 0) {
            layoutText(n, layout, w)
          } else {
            n.put("tx", text)
            textStyle(n, view, w)
          }
          pv?.let { n.put("pv", it) }
        }
        n
      }
      info(view).preparedText -> preparedLayoutText(view, rect, visible, w, alpha, pv, bg, borderWidth)
      isVector(view) -> vector(view, rect, visible, w, alpha, pv)
      view is ImageView -> box(view, "i", rect, visible, w, alpha).also { styleBox(it, view, null, 0f, w) }
      view is WebView -> box(view, "wv", rect, visible, w, alpha)
      view is SurfaceView || view is TextureView -> box(view, "p", rect, visible, w, alpha)
      hasPaint(bg, borderWidth) -> box(view, "s", rect, visible, w, alpha).also { styleBox(it, view, bg, borderWidth, w) }
      else -> null
    }
  }

  private fun isSwitch(view: CompoundButton): Boolean = info(view).switch

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
      val getter = info(view).preparedLayout ?: throw NoSuchMethodException("getPreparedLayout")
      val prepared = getter.invoke(view) ?: return null
      val layoutGetter =
        layoutGetters.getOrPut(prepared.javaClass) {
          try {
            prepared.javaClass.getMethod("getLayout")
          } catch (_: Throwable) {
            null
          }
        } ?: throw NoSuchMethodException("getLayout")
      val layout = layoutGetter.invoke(prepared) as Layout
      val text = layout.text?.toString() ?: ""
      if (isIconGlyph(text)) {
        vector(view, rect, visible, w, alpha, pv, "$text|${spanPaint(layout).color}")
      } else {
        val n = box(view, if (text.isBlank()) "s" else "t", rect, visible, w, alpha)
        styleBox(n, view, bg, borderWidth, w)
        if (text.isNotBlank()) {
          layoutText(n, layout, w)
          pv?.let { n.put("pv", it) }
        }
        n
      }
    } catch (_: Throwable) {
      if (hasPaint(bg, borderWidth)) box(view, "s", rect, visible, w, alpha) else null
    }

  /**
   * The text of a laid out text view, as the device drew it. React Native
   * sets the color, size, weight and letter spacing of a Text as spans,
   * not on the view's paint, so they are read by applying the spans of the
   * first character to a copy of the paint. The text goes with the
   * device's line breaks ("ln") and line height, so the replay draws the
   * same lines and does not wrap them again in another font.
   */
  private fun layoutText(n: JSONObject, layout: Layout, w: Walk) {
    val text = layout.text ?: return
    val lines = (0 until layout.lineCount).joinToString("\n") { i ->
      text.subSequence(layout.getLineStart(i), layout.getLineEnd(i)).toString().trimEnd()
    }
    n.put("tx", lines)
    n.put("ln", true)
    val paint = spanPaint(layout)
    n.put("tc", css(paint.color))
    n.put("fs", round(paint.textSize / w.density))
    val weight = paintWeight(paint)
    if (weight != 400) n.put("fw", weight)
    if (paint.letterSpacing != 0f) n.put("ls", round(paint.letterSpacing * paint.textSize / w.density))
    n.put("lh", round((layout.getLineBottom(0) - layout.getLineTop(0)) / w.density))
    when (layout.alignment) {
      Layout.Alignment.ALIGN_CENTER -> n.put("ta", "center")
      Layout.Alignment.ALIGN_OPPOSITE -> n.put("ta", "right")
      else -> {}
    }
  }

  /** The paint of a layout's first character, with its spans applied. */
  private fun spanPaint(layout: Layout): TextPaint {
    val paint = TextPaint(layout.paint)
    val text = layout.text
    if (text is Spanned && text.isNotEmpty()) {
      for (span in text.getSpans(0, 1, CharacterStyle::class.java)) {
        try {
          span.updateDrawState(paint)
        } catch (_: Throwable) {
          // A span that cannot apply to a copy keeps the paint as it is.
        }
      }
    }
    return paint
  }

  private fun paintWeight(paint: TextPaint): Int {
    val tf = paint.typeface
    return when {
      tf != null && Build.VERSION.SDK_INT >= 28 -> tf.weight
      tf?.isBold == true || paint.isFakeBoldText -> 700
      else -> 400
    }
  }

  /** The newest picture of each drawing, and when it was taken. */
  private class VectorPicture(val key: String, val data: String, val at: Long)

  /** Main thread only. */
  private val pictures = WeakHashMap<View, VectorPicture>()
  /** Drawings whose picture a worker thread encodes now. Main thread only. */
  private val encoding = WeakHashMap<View, Boolean>()

  /**
   * A drawing without a known content (react-native-svg) is drawn again at
   * most this often. Its content cannot be read, so it is drawn to see.
   */
  private const val VECTOR_REFRESH_MS = 5_000L
  /** A larger drawing is a placeholder: its picture would be too big to send. */
  private const val VECTOR_MAX_DP = 640f
  private const val VECTOR_MAX_SCALE = 2f
  /**
   * A picture with more pixels than this is encoded on a worker thread: a
   * large PNG can take tens of ms. A small one (an icon) is encoded at once,
   * so it is in the snapshot that first shows it.
   */
  private const val VECTOR_SYNC_PIXELS = 128 * 128

  /**
   * A drawing as a PNG, at most twice its size in dp: a react-native-svg
   * drawing, or a glyph of an icon font (@expo/vector-icons and the like),
   * which the replay could not draw without the font. Drawings and icons
   * are the app's own graphics, not user content, so they are recorded as
   * they are; a mask or a hidden tag over them still applies.
   *
   * content names what the view draws, when it is known (an icon's glyph
   * and color): the picture is then drawn again only when that changes.
   * A react-native-svg drawing has no such name and is drawn again at most
   * every VECTOR_REFRESH_MS.
   *
   * While a large picture is encoded, the node keeps the last picture of
   * the view, or none. When the encode ends, the next capture walks again
   * (lastSignature) and sends it.
   */
  private fun vector(
    view: View,
    rect: RectF,
    visible: RectF,
    w: Walk,
    alpha: Float,
    pv: String?,
    content: String? = null,
  ): JSONObject {
    val n = box(view, "v", rect, visible, w, alpha)
    if (pv == "mask") return n
    val wDp = view.width / w.density
    val hDp = view.height / w.density
    if (wDp > VECTOR_MAX_DP || hDp > VECTOR_MAX_DP) return n
    val key = "${view.width}x${view.height}|${content ?: ""}"
    val now = SystemClock.uptimeMillis()
    val cached = pictures[view]
    cached?.let { n.put("img", it.data) }
    if (cached != null && cached.key == key && (content != null || now - cached.at < VECTOR_REFRESH_MS)) return n
    if (encoding.containsKey(view)) return n
    try {
      val scale = min(w.density, VECTOR_MAX_SCALE)
      val bw = max(1, (wDp * scale).roundToInt())
      val bh = max(1, (hDp * scale).roundToInt())
      val bitmap = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      canvas.scale(scale / w.density, scale / w.density)
      view.draw(canvas)
      if (bw * bh <= VECTOR_SYNC_PIXELS) {
        val data = encode(bitmap)
        pictures[view] = VectorPicture(key, data, now)
        n.put("img", data)
        return n
      }
      encoding[view] = true
      val ref = java.lang.ref.WeakReference(view)
      worker.execute {
        val data =
          try {
            encode(bitmap)
          } catch (_: Throwable) {
            bitmap.recycle()
            null
          }
        main.post {
          val v = ref.get() ?: return@post
          encoding.remove(v)
          if (data == null) return@post
          val previous = pictures[v]?.data
          pictures[v] = VectorPicture(key, data, SystemClock.uptimeMillis())
          // The screen may not draw again: walk again to send the picture.
          if (data != previous) lastSignature = null
        }
      }
    } catch (_: Throwable) {
      // The placeholder, or the last picture, stays.
    }
    return n
  }

  /** PNG data URL of a bitmap. Recycles the bitmap. */
  private fun encode(bitmap: Bitmap): String {
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
    bitmap.recycle()
    return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
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

  private val HEX = "0123456789abcdef".toCharArray()

  /** ARGB int to CSS #rrggbbaa. String.format was slow for a call per color. */
  private fun css(color: Int): String {
    val out = CharArray(9)
    out[0] = '#'
    hex(out, 1, Color.red(color))
    hex(out, 3, Color.green(color))
    hex(out, 5, Color.blue(color))
    hex(out, 7, Color.alpha(color))
    return String(out)
  }

  private fun hex(out: CharArray, at: Int, byte: Int) {
    out[at] = HEX[(byte shr 4) and 0xF]
    out[at + 1] = HEX[byte and 0xF]
  }

  private fun round(v: Float): Double = Math.round(v * 10.0) / 10.0
}
