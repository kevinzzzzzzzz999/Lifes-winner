import UIKit

/// A separate, viewport-sized review layer. This never owns a PKDrawing.
@MainActor
final class ReviewOverlayView: UIView, UIGestureRecognizerDelegate {
    var records: [(BoardReview, CGRect)] = [] { didSet { setNeedsDisplay() } }
    var selectedID: UUID? { didSet { if oldValue != selectedID { setNeedsDisplay() } } }
    var zoom: CGFloat = 1
    var offset = CGPoint.zero
    var captureEnabled = false
    var color = "#ef4444"
    var style: BoardReviewStyle = .comment
    var eraserEnabled = false
    var strokeWidth: CGFloat = 3
    var onStroke: (([CGPoint]) -> Void)?
    var onErase: (([UUID]) -> Void)?
    var onNavigatePan: ((UIPanGestureRecognizer) -> Void)?
    var onNavigatePinch: ((UIPinchGestureRecognizer) -> Void)?
    var onTooLong: (() -> Void)?
    private var stroke: [CGPoint] = []
    private var rejected = false
    private var navigatingPinch = false
    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false; backgroundColor = .clear
        let draw = UIPanGestureRecognizer(target: self, action: #selector(drawing(_:)))
        draw.maximumNumberOfTouches = 1
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panning(_:)))
        pan.minimumNumberOfTouches = 2; pan.maximumNumberOfTouches = 2
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinching(_:)))
        pan.delegate = self; pinch.delegate = self
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapping(_:)))
        tap.require(toFail: draw)
        addGestureRecognizer(draw); addGestureRecognizer(pan); addGestureRecognizer(pinch); addGestureRecognizer(tap)
        accessibilityIdentifier = "review.canvas"
        accessibilityLabel = String(localized: "待修改批注浮层")
        accessibilityHint = String(localized: "单指圈画或轻点加评论；双指移动与缩放。不会修改原文或正式笔迹。")
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
    @objc private func drawing(_ gesture: UIPanGestureRecognizer) {
        guard captureEnabled else { onNavigatePan?(gesture); return }
        let p = gesture.location(in: self)
        switch gesture.state {
        case .began: rejected = false; stroke = [p]
        case .changed:
            guard !rejected else { return }
            if let last = stroke.last, hypot(p.x-last.x,p.y-last.y) < 1 { return }
            if stroke.count >= 2048 { rejected = true; stroke = []; onTooLong?() }
            else { stroke.append(p) }
        case .ended:
            if !rejected, !stroke.isEmpty { finish(stroke) }; stroke = []
        case .cancelled, .failed: stroke = []; rejected = false
        default: break
        }
        setNeedsDisplay()
    }
    @objc private func tapping(_ gesture: UITapGestureRecognizer) {
        if captureEnabled { finish([gesture.location(in: self)]) }
    }
    private func finish(_ points: [CGPoint]) {
        if eraserEnabled {
            let touched = records.filter { ReviewStrokeGeometry.hit(eraser: points, review: $0.0, world: $0.1, zoom: zoom, offset: offset) }.map { $0.0.id }
            if !touched.isEmpty { onErase?(touched) }
        } else { onStroke?(points) }
    }
    @objc private func panning(_ gesture: UIPanGestureRecognizer) { stroke = []; if !navigatingPinch { onNavigatePan?(gesture) } }
    @objc private func pinching(_ gesture: UIPinchGestureRecognizer) {
        stroke = []; navigatingPinch = gesture.state == .began || gesture.state == .changed
        onNavigatePinch?(gesture)
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        (gestureRecognizer is UIPinchGestureRecognizer && (otherGestureRecognizer as? UIPanGestureRecognizer)?.minimumNumberOfTouches == 2)
        || (otherGestureRecognizer is UIPinchGestureRecognizer && (gestureRecognizer as? UIPanGestureRecognizer)?.minimumNumberOfTouches == 2)
    }
    static func uiColor(_ hex: String) -> UIColor {
        let n = UInt32(hex.dropFirst(), radix: 16) ?? 0xef4444
        return UIColor(red: CGFloat((n >> 16)&255)/255, green: CGFloat((n >> 8)&255)/255, blue: CGFloat(n&255)/255, alpha: 1)
    }
    override func draw(_ rect: CGRect) {
        guard let c = UIGraphicsGetCurrentContext() else { return }
        c.setLineCap(.round); c.setLineJoin(.round); c.setLineWidth(3)
        for (review, world) in records {
            let box = ReviewStrokeGeometry.screenRect(world, zoom: zoom, offset: offset)
            let width = ReviewStrokeGeometry.width(review, world: world, zoom: zoom)
            guard box.insetBy(dx: -max(20, width), dy: -max(20, width)).intersects(bounds) else { continue }
            c.setLineWidth(width)
            c.setStrokeColor(Self.uiColor(review.color).withAlphaComponent(review.isHighlight ? 0.32 : 1).cgColor)
            if review.points.isEmpty {
                c.strokeEllipse(in: CGRect(x: box.midX-7, y: box.midY-7, width: 14, height: 14))
            } else {
                c.beginPath()
                for (index, point) in review.points.enumerated() {
                    let p = CGPoint(x: box.minX+point[0]*box.width, y: box.minY+point[1]*box.height)
                    if index == 0 { c.move(to: p) } else { c.addLine(to: p) }
                }
                c.strokePath()
            }
            if selectedID == review.id {
                c.saveGState()
                c.setStrokeColor(UIColor.systemTeal.cgColor); c.setLineWidth(2)
                c.setLineDash(phase: 0, lengths: [5, 4])
                c.stroke(box.insetBy(dx: -max(9, width / 2 + 4), dy: -max(9, width / 2 + 4)))
                c.restoreGState()
            }
            if !review.comment.isEmpty {
                c.setFillColor(Self.uiColor(review.color).cgColor)
                c.fillEllipse(in: CGRect(x: box.maxX-7, y: box.minY-7, width: 14, height: 14))
            }
        }
        if let first = stroke.first {
            if eraserEnabled {
                c.setLineWidth(20); c.setStrokeColor(UIColor.systemGray.withAlphaComponent(0.2).cgColor)
                c.beginPath(); c.move(to: first); for p in stroke.dropFirst() { c.addLine(to: p) }; c.strokePath()
                if let last = stroke.last { c.setLineWidth(1.5); c.setStrokeColor(UIColor.secondaryLabel.cgColor); c.strokeEllipse(in: CGRect(x: last.x-10, y: last.y-10, width: 20, height: 20)) }
                return
            }
            c.setLineWidth(strokeWidth)
            c.setStrokeColor(Self.uiColor(color).withAlphaComponent(style == .highlight ? 0.32 : 1).cgColor)
            c.beginPath(); c.move(to: first)
            for p in stroke.dropFirst() { c.addLine(to:p) }; c.strokePath()
        }
    }
}
