import SwiftUI
import UIKit

/// Local playback preferences only; never serialized into the board or video.
struct BoardSubtitleAppearance: Codable, Equatable {
    static let storageKey = "videoSubtitleAppearance.v1"
    static let defaults = BoardSubtitleAppearance()
    var fontSize: Double
    var textColor: String
    var strokeColor: String
    var strokeWidth: Double
    var backgroundColor: String
    var backgroundOpacity: Double

    init(fontSize: Double = 20, textColor: String = "#FFFFFF", strokeColor: String = "#000000",
         strokeWidth: Double = 0, backgroundColor: String = "#000000", backgroundOpacity: Double = 0.78) {
        self.fontSize = Self.clamp(fontSize, 12...48, fallback: 20)
        self.textColor = Self.hex(textColor, fallback: "#FFFFFF")
        self.strokeColor = Self.hex(strokeColor, fallback: "#000000")
        self.strokeWidth = Self.clamp(strokeWidth, 0...4, fallback: 0)
        self.backgroundColor = Self.hex(backgroundColor, fallback: "#000000")
        self.backgroundOpacity = Self.clamp(backgroundOpacity, 0...1, fallback: 0.78)
    }

    var normalized: Self {
        Self(fontSize: fontSize, textColor: textColor, strokeColor: strokeColor, strokeWidth: strokeWidth,
             backgroundColor: backgroundColor, backgroundOpacity: backgroundOpacity)
    }

    private enum CodingKeys: String, CodingKey { case fontSize, textColor, strokeColor, strokeWidth, backgroundColor, backgroundOpacity }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(fontSize: (try? values.decode(Double.self, forKey: .fontSize)) ?? 20,
                  textColor: (try? values.decode(String.self, forKey: .textColor)) ?? "#FFFFFF",
                  strokeColor: (try? values.decode(String.self, forKey: .strokeColor)) ?? "#000000",
                  strokeWidth: (try? values.decode(Double.self, forKey: .strokeWidth)) ?? 0,
                  backgroundColor: (try? values.decode(String.self, forKey: .backgroundColor)) ?? "#000000",
                  backgroundOpacity: (try? values.decode(Double.self, forKey: .backgroundOpacity)) ?? 0.78)
    }
    static func decode(_ data: Data?) -> Self {
        guard let data, data.count <= 4_096 else { return .defaults }
        return (try? JSONDecoder().decode(Self.self, from: data)) ?? .defaults
    }
    var encoded: Data { (try? JSONEncoder().encode(normalized)) ?? Data() }
    static func load(from defaults: UserDefaults = .standard) -> Self { decode(defaults.data(forKey: storageKey)) }
    func save(to defaults: UserDefaults = .standard) { defaults.set(encoded, forKey: Self.storageKey) }

    static func uiColor(_ hex: String) -> UIColor {
        let value = UInt32(String(Self.hex(hex, fallback: "#FFFFFF").dropFirst()), radix: 16) ?? 0xFFFFFF
        return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255,
                       blue: CGFloat(value & 255) / 255, alpha: 1)
    }
    static func hex(from color: Color) -> String {
        var r: CGFloat = 1, g: CGFloat = 1, b: CGFloat = 1, alpha: CGFloat = 1
        guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &alpha) else { return "#FFFFFF" }
        return String(format: "#%02X%02X%02X", Int((min(1, max(0, r)) * 255).rounded()),
                      Int((min(1, max(0, g)) * 255).rounded()), Int((min(1, max(0, b)) * 255).rounded()))
    }
    private static func hex(_ value: String, fallback: String) -> String {
        guard value.utf8.count == 7, value.first == "#", value.dropFirst().utf8.allSatisfy({
            (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
        }) else { return fallback }
        return value.uppercased()
    }
    private static func clamp(_ value: Double, _ range: ClosedRange<Double>, fallback: Double) -> Double {
        value.isFinite ? min(range.upperBound, max(range.lowerBound, value)) : fallback
    }
}

/// The production timed-caption view, shared by ordinary and in-app full screen.
/// NSAttributedString strokes glyph outlines; it never interprets subtitle HTML.
struct BoardSubtitleCaption: View {
    let text: String
    let appearance: BoardSubtitleAppearance
    var body: some View {
        let style = appearance.normalized
        BoardSubtitleGlyphs(text: text, appearance: style)
            .padding(10)
            .background(Color(uiColor: BoardSubtitleAppearance.uiColor(style.backgroundColor)).opacity(style.backgroundOpacity),
                        in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .ignore).accessibilityLabel(Text(verbatim: text))
            .allowsHitTesting(false)
    }
}

private struct BoardSubtitleGlyphs: UIViewRepresentable {
    let text: String
    let appearance: BoardSubtitleAppearance
    func makeUIView(context: Context) -> UILabel {
        let label = UILabel()
        label.numberOfLines = 8; label.backgroundColor = .clear
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }
    func updateUIView(_ label: UILabel, context: Context) {
        let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center; paragraph.lineBreakMode = .byWordWrapping
        label.attributedText = NSAttributedString(string: text, attributes: [
            .font: UIFont.systemFont(ofSize: appearance.fontSize, weight: .semibold),
            .foregroundColor: BoardSubtitleAppearance.uiColor(appearance.textColor),
            .strokeColor: BoardSubtitleAppearance.uiColor(appearance.strokeColor),
            // Negative stroke width draws both the glyph fill and its outline.
            .strokeWidth: -appearance.strokeWidth * 100 / appearance.fontSize,
            .paragraphStyle: paragraph])
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UILabel, context: Context) -> CGSize? {
        let width = max(1, min(proposal.width ?? 640, 4_096))
        return uiView.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
    }
}

struct BoardSubtitleAppearanceSheet: View {
    @Binding var appearance: BoardSubtitleAppearance
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "字幕预览")) {
                    BoardSubtitleCaption(text: String(localized: "字幕预览：文字清楚，画面保持可见。"), appearance: appearance)
                        .padding(12).frame(maxWidth: .infinity, minHeight: 100)
                        .background(Color.gray.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                        .accessibilityIdentifier("video.subtitle.appearance.preview")
                }
                Section(String(localized: "字幕文字")) {
                    HStack { Text(String(localized: "字号")); Spacer(); Text("\(Int(appearance.normalized.fontSize.rounded()))").monospacedDigit() }
                    Slider(value: number(\.fontSize), in: 12...48, step: 1)
                        .accessibilityLabel(String(localized: "字幕字号")).accessibilityIdentifier("video.subtitle.appearance.size")
                    ColorPicker(String(localized: "文字颜色"), selection: color(\.textColor), supportsOpacity: false)
                        .accessibilityIdentifier("video.subtitle.appearance.textColor")
                    HStack { Text(String(localized: "描边粗细")); Spacer(); Text(String(format: "%g", appearance.normalized.strokeWidth)).monospacedDigit() }
                    Slider(value: number(\.strokeWidth), in: 0...4, step: 0.5)
                        .accessibilityLabel(String(localized: "描边粗细")).accessibilityIdentifier("video.subtitle.appearance.strokeWidth")
                    ColorPicker(String(localized: "描边颜色"), selection: color(\.strokeColor), supportsOpacity: false)
                        .accessibilityIdentifier("video.subtitle.appearance.strokeColor")
                }
                Section {
                    ColorPicker(String(localized: "背景颜色"), selection: color(\.backgroundColor), supportsOpacity: false)
                        .accessibilityIdentifier("video.subtitle.appearance.backgroundColor")
                    HStack { Text(String(localized: "背景不透明度")); Spacer(); Text("\(Int((appearance.normalized.backgroundOpacity * 100).rounded()))%").monospacedDigit() }
                    Slider(value: number(\.backgroundOpacity), in: 0...1, step: 0.01)
                        .accessibilityLabel(String(localized: "背景不透明度")).accessibilityIdentifier("video.subtitle.appearance.backgroundOpacity")
                } header: { Text(String(localized: "字幕背景")) }
                  footer: { Text(String(localized: "0% 完全透明，100% 完全不透明。描边设为 0 即关闭。")) }
                Section {
                    Button(String(localized: "恢复默认字幕外观")) { appearance = .defaults }
                        .accessibilityIdentifier("video.subtitle.appearance.reset")
                } footer: { Text(String(localized: "此设备上的所有视频共用这些外观设置；不会修改视频、字幕文件或白板。")) }
            }
            .navigationTitle(String(localized: "字幕外观"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(String(localized: "完成")) { dismiss() }.accessibilityIdentifier("video.subtitle.appearance.done")
            } }
        }
    }
    private func number(_ key: WritableKeyPath<BoardSubtitleAppearance, Double>) -> Binding<Double> {
        Binding(get: { appearance.normalized[keyPath: key] }, set: { value in
            var updated = appearance; updated[keyPath: key] = value; appearance = updated.normalized
        })
    }
    private func color(_ key: WritableKeyPath<BoardSubtitleAppearance, String>) -> Binding<Color> {
        Binding(get: { Color(uiColor: BoardSubtitleAppearance.uiColor(appearance.normalized[keyPath: key])) }, set: { value in
            var updated = appearance; updated[keyPath: key] = BoardSubtitleAppearance.hex(from: value); appearance = updated.normalized
        })
    }
}

/// A frozen subtitle snapshot keeps system selection stable as playback time changes.
struct BoardSubtitleTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            BoardSubtitleSelectableText(text: text)
                .padding().accessibilityIdentifier("video.subtitle.selectableText")
                .navigationTitle(String(localized: "选择字幕文字"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "完成")) { dismiss() }
                        .accessibilityIdentifier("video.subtitle.selectText.done")
                } }
        }
    }
}

private struct BoardSubtitleSelectableText: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false; view.isSelectable = true
        view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear; view.textColor = .label
        view.accessibilityIdentifier = "video.subtitle.selectableText"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}
