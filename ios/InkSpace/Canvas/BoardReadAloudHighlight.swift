import UIKit

@MainActor final class BoardReadAloudHighlight: UIView {
    var normalizedRect: CGRect? { didSet {
        setNeedsDisplay()
        if let rect = normalizedRect {
            accessibilityValue = "x=\(rect.minX),y=\(rect.minY),width=\(rect.width),height=\(rect.height)"
            let visible = CGRect(x: rect.minX * bounds.width, y: rect.minY * bounds.height,
                width: rect.width * bounds.width, height: rect.height * bounds.height).intersection(bounds)
            accessibilityFrame = convert(visible, to: nil)
        } else { accessibilityValue = nil }
    } }
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear; isOpaque = false; isUserInteractionEnabled = false
        accessibilityIdentifier = "board.readAloud.highlight"
        isAccessibilityElement = true
        accessibilityLabel = String(localized: "正在朗读的原文位置")
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
    override func draw(_ rect: CGRect) {
        guard let normalizedRect, let context = UIGraphicsGetCurrentContext() else { return }
        let box = CGRect(x: normalizedRect.minX * bounds.width, y: normalizedRect.minY * bounds.height,
            width: normalizedRect.width * bounds.width, height: normalizedRect.height * bounds.height).insetBy(dx: -2, dy: -2)
        context.setFillColor(UIColor.systemYellow.withAlphaComponent(0.36).cgColor)
        context.fill(box)
        context.setStrokeColor(UIColor.systemYellow.cgColor)
        context.setLineWidth(2)
        context.stroke(box)
    }
}
