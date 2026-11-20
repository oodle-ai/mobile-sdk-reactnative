import UIKit

/// Walks the visible view tree and describes each view that draws
/// something as a wireframe: a box with a position, colors, and text. The
/// JS side turns wireframes into replay events and applies privacy
/// masking. Must run on the main thread.
final class WireframeWalker {
  private static let privacyPrefix = "oodle-privacy-"
  /// Walks longer than this stop early, to keep frames from dropping.
  private static let timeBudget: CFTimeInterval = 0.04
  /// A drawing is drawn again at most this often.
  private static let pictureRefresh: CFTimeInterval = 2
  /// A larger drawing is a placeholder: its picture would be too big to send.
  private static let pictureMaxPoints: CGFloat = 640
  private static let pictureMaxScale: CGFloat = 2
  /// The last picture of each drawing, so an unchanged one is not drawn
  /// and encoded on every capture.
  private static let pictures = NSMapTable<UIView, Picture>.weakToStrongObjects()

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

  private let maxNodes: Int
  private var nodes: [[String: Any]] = []
  private var truncated = false
  private var deadline: CFTimeInterval = 0

  init(maxNodes: Int) {
    self.maxNodes = maxNodes
  }

  func capture() -> [String: Any] {
    deadline = CACurrentMediaTime() + Self.timeBudget
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .filter { !$0.isHidden && $0.alpha > 0.01 && $0.bounds.width > 0 }
      .sorted { $0.windowLevel.rawValue < $1.windowLevel.rawValue }
    guard let main = windows.first(where: { $0.isKeyWindow }) ?? windows.first else {
      return ["width": 0, "height": 0, "nodes": []]
    }
    let screen = main.bounds
    for window in windows {
      walk(window, window: window, clip: screen, alpha: 1, privacy: nil)
    }
    var out: [String: Any] = [
      "width": round(Double(screen.width)),
      "height": round(Double(screen.height)),
      "nodes": nodes,
    ]
    if truncated { out["truncated"] = true }
    return out
  }

  private func walk(_ view: UIView, window: UIWindow, clip: CGRect, alpha parentAlpha: CGFloat, privacy: String?) {
    if nodes.count >= maxNodes || CACurrentMediaTime() > deadline {
      truncated = true
      return
    }
    if view.isHidden || view.bounds.width <= 0 || view.bounds.height <= 0 { return }
    let alpha = parentAlpha * view.alpha
    if alpha <= 0.01 { return }
    var rect = view.convert(view.bounds, to: window)
    rect.origin.x += window.frame.origin.x
    rect.origin.y += window.frame.origin.y
    let visible = rect.intersection(clip)
    if visible.isNull || visible.isEmpty { return }

    var pv = privacy
    if let id = nativeId(view), id.hasPrefix(Self.privacyPrefix) {
      switch String(id.dropFirst(Self.privacyPrefix.count)) {
      case "hidden":
        nodes.append(box(view, kind: "h", rect: rect, visible: visible, alpha: alpha))
        return
      case "mask": pv = "mask"
      case "allow": pv = "allow"
      default: break
      }
    }

    if let node = describe(view, rect: rect, visible: visible, alpha: alpha, privacy: pv) {
      nodes.append(node)
    }
    if isLeaf(view) { return }
    let childClip = (view.clipsToBounds || view is UIScrollView) ? visible : clip
    for child in view.subviews {
      walk(child, window: window, clip: childClip, alpha: alpha, privacy: pv)
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
    let (bg, radius) = background(view)
    let borderWidth = view.layer.borderWidth

    if let field = view as? UITextField {
      var n = box(view, kind: "in", rect: rect, visible: visible, alpha: alpha)
      style(&n, bg: bg, radius: radius, view: view)
      n["tx"] = field.text ?? ""
      if let placeholder = field.placeholder, !placeholder.isEmpty { n["ph"] = placeholder }
      textStyle(&n, color: field.textColor, font: field.font, alignment: field.textAlignment)
      if isSensitive(field) { n["sen"] = true }
      if let privacy = privacy { n["pv"] = privacy }
      return n
    }
    if let textView = view as? UITextView {
      var n = box(view, kind: textView.isEditable ? "in" : "t", rect: rect, visible: visible, alpha: alpha)
      style(&n, bg: bg, radius: radius, view: view)
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
      style(&n, bg: bg, radius: radius, view: view)
      if !text.isEmpty {
        n["tx"] = text
        textStyle(&n, color: label.textColor, font: label.font, alignment: label.textAlignment)
        if let privacy = privacy { n["pv"] = privacy }
      }
      return n
    }
    if name.contains("Paragraph") {
      return paragraph(view, rect: rect, visible: visible, alpha: alpha, privacy: privacy, bg: bg, radius: radius)
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
      style(&n, bg: bg, radius: radius, view: view)
      return n
    }
    return nil
  }

  /// Text drawn by React Native's paragraph view, from its attributed string.
  private func paragraph(
    _ view: UIView, rect: CGRect, visible: CGRect, alpha: CGFloat, privacy: String?, bg: UIColor?, radius: CGFloat
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
    style(&n, bg: bg, radius: radius, view: view)
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
      if let privacy = privacy { n["pv"] = privacy }
    }
    return n
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
    if let cached = Self.pictures.object(forKey: view), cached.key == key,
       content != nil || now - cached.at < Self.pictureRefresh {
      n["img"] = cached.data
      return n
    }
    let format = UIGraphicsImageRendererFormat()
    format.scale = min(view.window?.screen.scale ?? 2, Self.pictureMaxScale)
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      view.layer.render(in: context.cgContext)
    }
    guard let png = image.pngData() else { return n }
    let data = "data:image/png;base64," + png.base64EncodedString()
    Self.pictures.setObject(Picture(key: key, data: data, at: now), forKey: view)
    n["img"] = data
    return n
  }

  /// Background color and corner radius. Newer React Native versions draw
  /// the background in a sublayer, so that layer is checked too.
  private func background(_ view: UIView) -> (UIColor?, CGFloat) {
    if let color = view.backgroundColor, color.cgColor.alpha > 0.01 {
      return (color, view.layer.cornerRadius)
    }
    if let cg = view.layer.backgroundColor, cg.alpha > 0.01 {
      return (UIColor(cgColor: cg), view.layer.cornerRadius)
    }
    for layer in view.layer.sublayers ?? [] {
      if let cg = layer.backgroundColor, cg.alpha > 0.01,
         abs(layer.frame.width - view.bounds.width) < 1, abs(layer.frame.height - view.bounds.height) < 1 {
        return (UIColor(cgColor: cg), max(layer.cornerRadius, view.layer.cornerRadius))
      }
    }
    return (nil, view.layer.cornerRadius)
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

  private func style(_ n: inout [String: Any], bg: UIColor?, radius: CGFloat, view: UIView) {
    if let bg = bg { n["bg"] = css(bg) }
    if radius > 0 { n["r"] = round(Double(radius)) }
    let width = view.layer.borderWidth
    if width > 0 {
      n["bw"] = round(Double(width))
      if let color = view.layer.borderColor { n["bc"] = css(UIColor(cgColor: color)) }
    }
  }

  private func textStyle(_ n: inout [String: Any], color: UIColor?, font: UIFont?, alignment: NSTextAlignment) {
    if let color = color { n["tc"] = css(color) }
    if let font = font {
      n["fs"] = round(Double(font.pointSize))
      if font.fontDescriptor.symbolicTraits.contains(.traitBold) { n["fw"] = 700 }
    }
    switch alignment {
    case .center: n["ta"] = "center"
    case .right: n["ta"] = "right"
    default: break
    }
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
