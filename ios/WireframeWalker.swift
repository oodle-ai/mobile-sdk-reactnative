import UIKit

/// Walks the visible view tree and describes each view that draws
/// something as a wireframe: a box with a position, colors, and text. The
/// JS side turns wireframes into replay events and applies privacy
/// masking. Must run on the main thread.
final class WireframeWalker {
  private static let privacyPrefix = "oodle-privacy-"
  /// Main thread time of one slice of a walk. The walk gives the main
  /// thread back between slices, so frames can draw while it goes on.
  private static let sliceBudget: CFTimeInterval = 0.004
  /// Main thread time of all slices of one walk. A longer walk stops
  /// ("truncated").
  private static let walkBudget: CFTimeInterval = 0.04
  /// A walk that takes longer than this, in slices, stops. The screen
  /// keeps changing.
  private static let maxWallTime: CFTimeInterval = 1
  /// A drawing without a known content (react-native-svg) is drawn again
  /// at most this often. Its content cannot be read, so it is drawn to see.
  private static let pictureRefresh: CFTimeInterval = 5
  /// A picture with more pixels than this is encoded on a background
  /// queue: a large PNG can take tens of ms. A small one (an icon) is
  /// encoded at once, so it is in the snapshot that first shows it.
  private static let pictureSyncPixels: CGFloat = 128 * 128
  private static let encodeQueue = DispatchQueue(label: "ai.oodle.rum.picture", qos: .utility)
  /// Drawings whose picture is encoded now. Main thread only.
  private static let encoding = NSHashTable<UIView>.weakObjects()
  /// A larger drawing is a placeholder: its picture would be too big to send.
  private static let pictureMaxPoints: CGFloat = 640
  private static let pictureMaxScale: CGFloat = 2
  /// The last picture of each drawing, so an unchanged one is not drawn
  /// and encoded on every capture.
  private static let pictures = NSMapTable<UIView, Picture>.weakToStrongObjects()
  /// The last device lines of each paragraph. TextKit layout of every
  /// text on every walk was a large part of its time.
  private static let lines = NSMapTable<UIView, Lines>.weakToStrongObjects()
  /// The border read from each view's border image. Reading it draws the
  /// image into a buffer.
  private static let borders = NSMapTable<UIView, ImageBorder>.weakToStrongObjects()

  private final class Picture {
    let key: String
    let data: String
    let at: CFTimeInterval

    init(key: String, data: String, at: CFTimeInterval) {
      self.key = key
      self.data = data
      self.at = at
    }
  }

  private final class Lines {
    let text: NSAttributedString
    let size: CGSize
    let result: (lines: String, lineHeight: CGFloat)?

    init(text: NSAttributedString, size: CGSize, result: (lines: String, lineHeight: CGFloat)?) {
      self.text = text
      self.size = size
      self.result = result
    }
  }

  private final class ImageBorder {
    /// Held so that a new image cannot reuse its address.
    let image: CGImage
    let scale: CGFloat
    let result: (width: CGFloat, color: UIColor?)?

    init(image: CGImage, scale: CGFloat, result: (width: CGFloat, color: UIColor?)?) {
      self.image = image
      self.scale = scale
      self.result = result
    }
  }

  /// A view still to visit, with what its parents give it.
  private struct Item {
    let view: UIView
    let window: UIWindow
    let clip: CGRect
    let alpha: CGFloat
    let privacy: String?
  }

  private let maxNodes: Int
  private var nodes: [[String: Any]] = []
  /// Visible areas of OodlePrivacy mask views, [x, y, w, h] in points.
  /// Touches there are not recorded.
  private var masks: [[Double]] = []
  private var truncated = false
  /// Views to visit, last on top. Children go on in reverse, so the walk
  /// is in draw order.
  private var stack: [Item] = []
  private var spent: CFTimeInterval = 0
  private var startedAt: CFTimeInterval = 0
  private var screen: CGRect = .zero
  private var started = false

  init(maxNodes: Int) {
    self.maxNodes = maxNodes
  }

  /// Runs one slice of the walk on the main thread. Returns true when the
  /// walk is done; call `result()` then. Otherwise call again on a later
  /// turn of the main queue, so frames can draw between slices.
  func step() -> Bool {
    let sliceStart = CACurrentMediaTime()
    if !started {
      started = true
      startedAt = sliceStart
      let windows = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }
        .filter { !$0.isHidden && $0.alpha > 0.01 && $0.bounds.width > 0 }
        .sorted { $0.windowLevel.rawValue < $1.windowLevel.rawValue }
      guard let main = windows.first(where: { $0.isKeyWindow }) ?? windows.first else { return true }
      screen = main.bounds
      for window in windows.reversed() {
        stack.append(Item(view: window, window: window, clip: screen, alpha: 1, privacy: nil))
      }
    }
    while let item = stack.popLast() {
      let now = CACurrentMediaTime()
      if nodes.count >= maxNodes || spent + (now - sliceStart) > Self.walkBudget || now - startedAt > Self.maxWallTime {
        truncated = true
        stack.removeAll()
        break
      }
      if now - sliceStart >= Self.sliceBudget {
        stack.append(item)
        spent += now - sliceStart
        return false
      }
      visit(item)
    }
    return true
  }

  func result() -> [String: Any] {
    if screen.width <= 0 { return ["width": 0, "height": 0, "nodes": []] }
    var out: [String: Any] = [
      "width": round(Double(screen.width)),
      "height": round(Double(screen.height)),
      "nodes": nodes,
    ]
    if truncated { out["truncated"] = true }
    if !masks.isEmpty { out["masks"] = masks }
    return out
  }

  private func visit(_ item: Item) {
    let view = item.view
    // The walk runs in slices: a view can leave the screen between them.
    // A window has no window of its own, so it is checked by itself.
    if let window = view as? UIWindow {
      if window.isHidden || window.windowScene == nil { return }
    } else if view.window == nil {
      return
    }
    if view.isHidden || view.bounds.width <= 0 || view.bounds.height <= 0 { return }
    let alpha = item.alpha * view.alpha
    if alpha <= 0.01 { return }
    let window = item.window
    var rect = view.convert(view.bounds, to: window)
    rect.origin.x += window.frame.origin.x
    rect.origin.y += window.frame.origin.y
    let visible = rect.intersection(item.clip)
    if visible.isNull || visible.isEmpty { return }

    var pv = item.privacy
    if let id = nativeId(view), id.hasPrefix(Self.privacyPrefix) {
      switch String(id.dropFirst(Self.privacyPrefix.count)) {
      case "hidden":
        nodes.append(box(view, kind: "h", rect: rect, visible: visible, alpha: alpha))
        return
      case "mask":
        pv = "mask"
        masks.append([
          round(Double(visible.minX)), round(Double(visible.minY)),
          round(Double(visible.width)), round(Double(visible.height)),
        ])
      case "allow": pv = "allow"
      default: break
      }
    }

    if let node = describe(view, rect: rect, visible: visible, alpha: alpha, privacy: pv) {
      nodes.append(node)
    }
    if isLeaf(view) { return }
    let childClip = (view.clipsToBounds || view is UIScrollView) ? visible : item.clip
    for child in view.subviews.reversed() {
      stack.append(Item(view: child, window: window, clip: childClip, alpha: alpha, privacy: pv))
    }
  }

  private func isLeaf(_ view: UIView) -> Bool {
    if view is UITextField || view is UITextView || view is UISwitch || view is UIImageView { return true }
    let name = NSStringFromClass(type(of: view))
    return name.contains("WKWebView") || name.contains("Paragraph") || isVector(view)
  }

  /// A react-native-svg drawing. Its shapes are views of their own, which
  /// the picture of the drawing already shows.
  private func isVector(_ view: UIView) -> Bool {
    NSStringFromClass(type(of: view)) == "RNSVGSvgView"
  }

  /// Text that is a glyph of an icon font (@expo/vector-icons and the
  /// like): characters of the Private Use Area, or an emoji. The replay has
  /// no copy of the font, so the glyph is sent as a picture.
  static func isIconGlyph(_ text: String) -> Bool {
    let units = Array(text.utf16)
    if units.isEmpty || units.count > 4 { return false }
    return units.allSatisfy { (0xE000...0xF8FF).contains($0) || UTF16.isLeadSurrogate($0) || UTF16.isTrailSurrogate($0) }
  }

  /// React Native keeps the `nativeID` prop as `nativeId` (Fabric) or
  /// `nativeID` (older renderer). Read through KVC only when it exists.
  private func nativeId(_ view: UIView) -> String? {
    for key in ["nativeId", "nativeID"] where view.responds(to: NSSelectorFromString(key)) {
      if let value = view.value(forKey: key) as? String { return value }
    }
    return nil
  }

  private func describe(_ view: UIView, rect: CGRect, visible: CGRect, alpha: CGFloat, privacy: String?) -> [String: Any]? {
    let name = NSStringFromClass(type(of: view))
    let layers = drawingLayers(view)
    let (bg, radius) = background(view, layers: layers)
    // Found once per view: reading a border image draws it into a buffer.
    let drawnBorder = border(view, layers: layers)
    let borderWidth = drawnBorder?.width ?? 0

    if let field = view as? UITextField {
      var n = box(view, kind: "in", rect: rect, visible: visible, alpha: alpha)
      style(&n, bg: bg, radius: radius, border: drawnBorder)
      n["tx"] = field.text ?? ""
      if let placeholder = field.placeholder, !placeholder.isEmpty { n["ph"] = placeholder }
      textStyle(&n, color: field.textColor, font: field.font, alignment: field.textAlignment)
      if isSensitive(field) { n["sen"] = true }
      if let privacy = privacy { n["pv"] = privacy }
      return n
    }
    if let textView = view as? UITextView {
      var n = box(view, kind: textView.isEditable ? "in" : "t", rect: rect, visible: visible, alpha: alpha)
      style(&n, bg: bg, radius: radius, border: drawnBorder)
      n["tx"] = textView.text ?? ""
      textStyle(&n, color: textView.textColor, font: textView.font, alignment: textView.textAlignment)
      if textView.isSecureTextEntry { n["sen"] = true }
      if let privacy = privacy { n["pv"] = privacy }
      return n
    }
    if let toggle = view as? UISwitch {
      var n = box(view, kind: "sw", rect: rect, visible: visible, alpha: alpha)
      n["on"] = toggle.isOn
      if let tint = toggle.onTintColor { n["bg"] = css(tint) }
      return n
    }
    if let label = view as? UILabel {
      let text = label.text ?? ""
      if Self.isIconGlyph(text) {
        let color = label.textColor.map(css) ?? ""
        return picture(view, rect: rect, visible: visible, alpha: alpha, privacy: privacy, content: "\(text)|\(color)")
      }
      if text.isEmpty && bg == nil { return nil }
      var n = box(view, kind: text.isEmpty ? "s" : "t", rect: rect, visible: visible, alpha: alpha)
      style(&n, bg: bg, radius: radius, border: drawnBorder)
      if !text.isEmpty {
        n["tx"] = text
        textStyle(&n, color: label.textColor, font: label.font, alignment: label.textAlignment)
        if let privacy = privacy { n["pv"] = privacy }
      }
      return n
    }
    if name.contains("Paragraph") {
      return paragraph(
        view, rect: rect, visible: visible, alpha: alpha, privacy: privacy, bg: bg, radius: radius, border: drawnBorder
      )
    }
    if isVector(view) {
      return picture(view, rect: rect, visible: visible, alpha: alpha, privacy: privacy, content: nil)
    }
    if view is UIImageView || name.contains("ImageComponentView") || name.contains("RCTImageView") {
      var n = box(view, kind: "i", rect: rect, visible: visible, alpha: alpha)
      if radius > 0 { n["r"] = round(Double(radius)) }
      return n
    }
    if name.contains("WKWebView") {
      return box(view, kind: "wv", rect: rect, visible: visible, alpha: alpha)
    }
    if bg != nil || borderWidth > 0 {
      var n = box(view, kind: "s", rect: rect, visible: visible, alpha: alpha)
      style(&n, bg: bg, radius: radius, border: drawnBorder)
      return n
    }
    return nil
  }

  /// Text drawn by React Native's paragraph view, from its attributed string.
  private func paragraph(
    _ view: UIView, rect: CGRect, visible: CGRect, alpha: CGFloat, privacy: String?, bg: UIColor?, radius: CGFloat,
    border drawnBorder: (width: CGFloat, color: UIColor?)?
  ) -> [String: Any]? {
    let selector = NSSelectorFromString("attributedText")
    var attributed: NSAttributedString?
    if view.responds(to: selector) {
      attributed = view.perform(selector)?.takeUnretainedValue() as? NSAttributedString
    }
    let text = attributed?.string ?? ""
    if let attributed = attributed, Self.isIconGlyph(text) {
      let color = (attributed.attributes(at: 0, effectiveRange: nil)[.foregroundColor] as? UIColor).map(css) ?? ""
      return picture(view, rect: rect, visible: visible, alpha: alpha, privacy: privacy, content: "\(text)|\(color)")
    }
    if text.isEmpty && bg == nil { return nil }
    var n = box(view, kind: text.isEmpty ? "s" : "t", rect: rect, visible: visible, alpha: alpha)
    style(&n, bg: bg, radius: radius, border: drawnBorder)
    if let attributed = attributed, attributed.length > 0 {
      n["tx"] = text
      let attrs = attributed.attributes(at: 0, effectiveRange: nil)
      let paragraphStyle = attrs[.paragraphStyle] as? NSParagraphStyle
      textStyle(
        &n,
        color: attrs[.foregroundColor] as? UIColor,
        font: attrs[.font] as? UIFont,
        alignment: paragraphStyle?.alignment ?? .natural
      )
      if let kern = attrs[.kern] as? NSNumber, kern.doubleValue != 0 {
        n["ls"] = round(kern.doubleValue)
      }
      if let laid = cachedDeviceLines(view, attributed, size: view.bounds.size) {
        n["tx"] = laid.lines
        n["ln"] = true
        n["lh"] = round(Double(laid.lineHeight))
      }
      if let privacy = privacy { n["pv"] = privacy }
    }
    return n
  }

  /// deviceLines, laid out again only when the text or the size changed.
  private func cachedDeviceLines(
    _ view: UIView, _ attributed: NSAttributedString, size: CGSize
  ) -> (lines: String, lineHeight: CGFloat)? {
    if let cached = Self.lines.object(forKey: view), cached.size == size,
       cached.text === attributed || cached.text.isEqual(to: attributed) {
      return cached.result
    }
    let result = deviceLines(attributed, size: size)
    let copy = (attributed.copy() as? NSAttributedString) ?? attributed
    Self.lines.setObject(Lines(text: copy, size: size, result: result), forKey: view)
    return result
  }

  /// The lines of a paragraph as the device breaks them. The replay draws
  /// text in a web font, which is wider or narrower than the app's: it
  /// broke the lines again, and a line that wrapped fell below the box and
  /// was cut off ("Ava · Driver" showed as "Ava ·"). Sent with `ln`, the
  /// replay draws these lines as they are. React Native lays its text out
  /// with TextKit in the view's size, as this does.
  ///
  /// Gives the lines and the height of the first, or nil when the text
  /// does not lay out.
  private func deviceLines(_ attributed: NSAttributedString, size: CGSize) -> (lines: String, lineHeight: CGFloat)? {
    guard size.width > 0 else { return nil }
    let wrapped = NSMutableAttributedString(attributedString: attributed)
    // A truncating line break mode lays each paragraph out on one line.
    // React Native truncates at the line count, not by the mode.
    wrapped.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: wrapped.length)) { value, range, _ in
      guard let style = value as? NSParagraphStyle, style.lineBreakMode != .byWordWrapping,
            let copy = style.mutableCopy() as? NSMutableParagraphStyle
      else { return }
      copy.lineBreakMode = .byWordWrapping
      wrapped.addAttribute(.paragraphStyle, value: copy, range: range)
    }
    let storage = NSTextStorage(attributedString: wrapped)
    let manager = NSLayoutManager()
    // Half a point of room: the view's width is rounded to the pixel
    // grid, which can be a little less than the text measured.
    let container = NSTextContainer(size: CGSize(width: size.width + 0.5, height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    manager.addTextContainer(container)
    storage.addLayoutManager(manager)
    let text = wrapped.string as NSString
    var lines: [String] = []
    var firstHeight: CGFloat = 0
    manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { rect, _, _, glyphs, stop in
      // Lines below the view are the ones React Native cut at its line count.
      if !lines.isEmpty && rect.minY >= size.height - 0.5 {
        stop.pointee = true
        return
      }
      let chars = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
      var line = text.substring(with: chars)
      while let last = line.unicodeScalars.last, CharacterSet.whitespacesAndNewlines.contains(last) {
        line.unicodeScalars.removeLast()
      }
      lines.append(line)
      if firstHeight == 0 { firstHeight = rect.height }
    }
    if lines.isEmpty || firstHeight <= 0 { return nil }
    return (lines.joined(separator: "\n"), firstHeight)
  }

  /// A drawing as a PNG, at most twice its size in points: a
  /// react-native-svg drawing, or a glyph of an icon font. Drawings and
  /// icons are the app's own graphics, not user content, so they are
  /// recorded as they are; a mask or a hidden tag over them still applies.
  ///
  /// `content` names what the view draws, when it is known (an icon's
  /// glyph and color): the picture is then drawn again only when that
  /// changes. A react-native-svg drawing has no such name and is drawn
  /// again at most every `pictureRefresh`.
  private func picture(
    _ view: UIView, rect: CGRect, visible: CGRect, alpha: CGFloat, privacy: String?, content: String?
  ) -> [String: Any] {
    var n = box(view, kind: "v", rect: rect, visible: visible, alpha: alpha)
    if privacy == "mask" { return n }
    let size = view.bounds.size
    if size.width > Self.pictureMaxPoints || size.height > Self.pictureMaxPoints { return n }
    let key = "\(Int(size.width.rounded()))x\(Int(size.height.rounded()))|\(content ?? "")"
    let now = CACurrentMediaTime()
    // While a new picture is encoded, the node keeps the last one.
    let cached = Self.pictures.object(forKey: view)
    if let cached = cached { n["img"] = cached.data }
    if let cached = cached, cached.key == key, content != nil || now - cached.at < Self.pictureRefresh {
      return n
    }
    if Self.encoding.contains(view) { return n }
    let format = UIGraphicsImageRendererFormat()
    format.scale = min(view.window?.screen.scale ?? 2, Self.pictureMaxScale)
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      view.layer.render(in: context.cgContext)
    }
    let pixels = size.width * size.height * format.scale * format.scale
    if pixels <= Self.pictureSyncPixels {
      guard let png = image.pngData() else { return n }
      let data = "data:image/png;base64," + png.base64EncodedString()
      Self.pictures.setObject(Picture(key: key, data: data, at: now), forKey: view)
      n["img"] = data
      return n
    }
    // The next walk sends it: iOS walks on each capture.
    Self.encoding.add(view)
    Self.encodeQueue.async { [weak view] in
      let data = image.pngData().map { "data:image/png;base64," + $0.base64EncodedString() }
      DispatchQueue.main.async {
        guard let view = view else { return }
        Self.encoding.remove(view)
        if let data = data {
          Self.pictures.setObject(Picture(key: key, data: data, at: CACurrentMediaTime()), forKey: view)
        }
      }
    }
    return n
  }

  /// Background color and corner radius. Newer React Native versions draw
  /// the background in a sublayer, so that layer is checked too.
  private func background(_ view: UIView, layers: [CALayer]) -> (UIColor?, CGFloat) {
    let radius = cornerRadius(view, layers: layers)
    if let color = view.backgroundColor, color.cgColor.alpha > 0.01 {
      return (color, radius)
    }
    if let cg = view.layer.backgroundColor, cg.alpha > 0.01 {
      return (UIColor(cgColor: cg), radius)
    }
    for layer in layers {
      if let cg = layer.backgroundColor, cg.alpha > 0.01 {
        return (UIColor(cgColor: cg), radius)
      }
    }
    return (nil, radius)
  }

  /// The layers the size of the view that draw for the view itself, not
  /// for a subview. React Native draws there what a layer of its own
  /// cannot: a background with uneven corners, and a border that does not
  /// clip the content (`_backgroundColorLayer`, `_borderLayer`).
  private func drawingLayers(_ view: UIView) -> [CALayer] {
    (view.layer.sublayers ?? []).filter { layer in
      !(layer.delegate is UIView)
        && abs(layer.frame.width - view.bounds.width) < 1
        && abs(layer.frame.height - view.bounds.height) < 1
    }
  }

  /// The corner radius. When React Native draws the border in a layer of
  /// its own, the view's radius is 0, and the radius is on that layer and
  /// on the background layer.
  private func cornerRadius(_ view: UIView, layers: [CALayer]) -> CGFloat {
    if view.layer.cornerRadius > 0 { return view.layer.cornerRadius }
    return layers.map(\.cornerRadius).max() ?? 0
  }

  /// The border's width and color: the view's own, or the one React
  /// Native drew into its border layer as an image. That image is the
  /// border of a small box, stretched to the view, so the width is the run
  /// of drawn pixels from the left edge of its middle row, and the color
  /// is the first of them.
  private func border(_ view: UIView, layers: [CALayer]) -> (width: CGFloat, color: UIColor?)? {
    if view.layer.borderWidth > 0 {
      return (view.layer.borderWidth, view.layer.borderColor.map { UIColor(cgColor: $0) })
    }
    for layer in layers {
      guard let contents = layer.contents, CFGetTypeID(contents as CFTypeRef) == CGImage.typeID else { continue }
      let image = contents as! CGImage
      let scale = layer.contentsScale
      let drawn: (width: CGFloat, color: UIColor?)?
      if let cached = Self.borders.object(forKey: view), cached.image === image, cached.scale == scale {
        drawn = cached.result
      } else {
        drawn = imageBorder(image, scale: scale)
        Self.borders.setObject(ImageBorder(image: image, scale: scale, result: drawn), forKey: view)
      }
      if let drawn = drawn { return drawn }
    }
    return nil
  }

  private func imageBorder(_ image: CGImage, scale: CGFloat) -> (width: CGFloat, color: UIColor?)? {
    let w = image.width
    let h = image.height
    guard w > 0, h > 0, w * h <= 512 * 512 else { return nil }
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let drawn: Bool = px.withUnsafeMutableBytes { buffer in
      guard let ctx = CGContext(
        data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else { return false }
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
      return true
    }
    guard drawn else { return nil }
    let row = h / 2
    func alpha(_ x: Int) -> UInt8 { px[(row * w + x) * 4 + 3] }
    var run = 0
    while run < w / 2 && alpha(run) > 0 { run += 1 }
    guard run > 0 else { return nil }
    let i = row * w * 4
    let a = CGFloat(px[i + 3]) / 255
    let color = UIColor(
      red: min(CGFloat(px[i]) / 255 / a, 1), green: min(CGFloat(px[i + 1]) / 255 / a, 1),
      blue: min(CGFloat(px[i + 2]) / 255 / a, 1), alpha: a
    )
    return (CGFloat(run) / max(scale, 1), color)
  }

  private func isSensitive(_ field: UITextField) -> Bool {
    if field.isSecureTextEntry { return true }
    switch field.keyboardType {
    case .emailAddress, .phonePad, .namePhonePad: return true
    default: break
    }
    if let type = field.textContentType {
      let sensitive: [UITextContentType] = [
        .password, .newPassword, .oneTimeCode, .emailAddress, .telephoneNumber, .creditCardNumber, .fullStreetAddress,
      ]
      return sensitive.contains(type)
    }
    return false
  }

  private func box(_ view: UIView, kind: String, rect: CGRect, visible: CGRect, alpha: CGFloat) -> [String: Any] {
    var n: [String: Any] = [
      "id": ObjectIdentifier(view).hashValue & 0x7fff_ffff,
      "k": kind,
      "x": round(Double(rect.minX)),
      "y": round(Double(rect.minY)),
      "w": round(Double(rect.width)),
      "h": round(Double(rect.height)),
    ]
    if alpha < 0.99 { n["o"] = round(Double(alpha)) }
    if visible != rect {
      n["c"] = [
        round(Double(visible.minY - rect.minY)),
        round(Double(rect.maxX - visible.maxX)),
        round(Double(rect.maxY - visible.maxY)),
        round(Double(visible.minX - rect.minX)),
      ]
    }
    return n
  }

  private func style(_ n: inout [String: Any], bg: UIColor?, radius: CGFloat, border: (width: CGFloat, color: UIColor?)?) {
    if let bg = bg { n["bg"] = css(bg) }
    if radius > 0 { n["r"] = round(Double(radius)) }
    if let drawn = border, drawn.width > 0 {
      n["bw"] = round(Double(drawn.width))
      if let color = drawn.color { n["bc"] = css(color) }
    }
  }

  private func textStyle(_ n: inout [String: Any], color: UIColor?, font: UIFont?, alignment: NSTextAlignment) {
    if let color = color { n["tc"] = css(color) }
    if let font = font {
      n["fs"] = round(Double(font.pointSize))
      let weight = cssWeight(font)
      if weight != 400 { n["fw"] = weight }
    }
    switch alignment {
    case .center: n["ta"] = "center"
    case .right: n["ta"] = "right"
    default: break
    }
  }

  /// The CSS weight of a font, from its weight trait (semibold is 600, not
  /// bold), or from the bold trait when the font has no weight.
  private func cssWeight(_ font: UIFont) -> Int {
    let traits = font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any]
    if let weight = (traits?[.weight] as? NSNumber).map({ CGFloat($0.doubleValue) }) {
      let scale: [(CGFloat, Int)] = [
        (-0.8, 100), (-0.6, 200), (-0.4, 300), (0, 400), (0.23, 500), (0.3, 600), (0.4, 700), (0.56, 800), (0.62, 900),
      ]
      return scale.min { abs($0.0 - weight) < abs($1.0 - weight) }!.1
    }
    return font.fontDescriptor.symbolicTraits.contains(.traitBold) ? 700 : 400
  }

  /// UIColor to CSS #rrggbbaa.
  private func css(_ color: UIColor) -> String {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    if !color.getRed(&r, green: &g, blue: &b, alpha: &a) {
      var white: CGFloat = 0
      if color.getWhite(&white, alpha: &a) {
        r = white
        g = white
        b = white
      }
    }
    func byte(_ v: CGFloat) -> Int { Int((min(max(v, 0), 1) * 255).rounded()) }
    return String(format: "#%02x%02x%02x%02x", byte(r), byte(g), byte(b), byte(a))
  }

  private func round(_ v: Double) -> Double {
    (v * 10).rounded() / 10
  }
}
