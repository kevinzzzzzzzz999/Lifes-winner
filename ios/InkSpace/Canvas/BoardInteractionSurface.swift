import UIKit

/// Exists only in arrange/frame modes. Ink mode sends input directly to PencilKit.
@MainActor
final class BoardInteractionSurface: UIView {
    var onPan: ((UIPanGestureRecognizer) -> Void)?
    var onPinch: ((UIPinchGestureRecognizer) -> Void)?
    var onTap: ((UITapGestureRecognizer) -> Void)?
    var onDoubleTap: ((UITapGestureRecognizer) -> Void)?
    var allowsTextEditing = false { didSet { if oldValue != allowsTextEditing { doubleTap.isEnabled = allowsTextEditing } } }
    private lazy var doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
    var selectionRect: CGRect? { didSet { setNeedsDisplay() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.maximumNumberOfTouches = 1
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.require(toFail: pan)
        doubleTap.numberOfTapsRequired = 2
        doubleTap.isEnabled = false
        doubleTap.require(toFail: pan)
        doubleTap.require(toFail: pinch)
        tap.require(toFail: doubleTap)
        addGestureRecognizer(pan)
        addGestureRecognizer(pinch)
        addGestureRecognizer(tap)
        addGestureRecognizer(doubleTap)
        accessibilityLabel = String(localized: "白板节点整理区域")
        accessibilityHint = String(localized: "轻点选择多个节点，拖动移动；双击文字编辑；双指缩放。框选模式下拖出矩形，把完整包含的笔迹转为节点。")
    }

    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    @objc private func panned(_ recognizer: UIPanGestureRecognizer) { onPan?(recognizer) }
    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) { onPinch?(recognizer) }
    @objc private func tapped(_ recognizer: UITapGestureRecognizer) { onTap?(recognizer) }
    @objc private func doubleTapped(_ recognizer: UITapGestureRecognizer) { onDoubleTap?(recognizer) }

    override func draw(_ rect: CGRect) {
        guard let selectionRect, let context = UIGraphicsGetCurrentContext() else { return }
        context.setFillColor(UIColor.systemTeal.withAlphaComponent(0.10).cgColor)
        context.fill(selectionRect)
        context.setStrokeColor(UIColor.systemTeal.cgColor)
        context.setLineWidth(2)
        context.setLineDash(phase: 0, lengths: [7, 4])
        context.stroke(selectionRect)
    }
}
