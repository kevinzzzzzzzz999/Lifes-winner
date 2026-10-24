import SwiftUI
import PencilKit
import UIKit

/// Separate read-only presentation. A fresh DocumentLibrary reads source pages
/// and hides this board's already-written PDF ink in memory, so future strokes
/// never appear in the background. It has no BoardStore, delegate save, or binding.
struct InkReplayCanvas: UIViewRepresentable {
    let snapshot: InkReplaySnapshot
    let items: [BoardItem]
    let boardID: UUID
    let rootURL: URL?
    var pdfOwnerIDs: Set<UUID> = []
    var initialViewport: BoardViewport? = nil
    let count: Int
    let displayMode: InkReplayDisplayMode
    let following: Bool
    let overviewRequest: Int
    let reloadRequest: Int
    let onManualNavigation: () -> Void
    let onStatus: (String, String) -> Void

    func makeUIView(context: Context) -> InkReplayCanvasHost {
        InkReplayCanvasHost(snapshot: snapshot, items: items, boardID: boardID, rootURL: rootURL, pdfOwnerIDs: pdfOwnerIDs, initialViewport: initialViewport)
    }
    func updateUIView(_ view: InkReplayCanvasHost, context: Context) {
        view.onManualNavigation = onManualNavigation
        view.onStatus = onStatus
        view.update(count: count, displayMode: displayMode, following: following, overviewRequest: overviewRequest, reloadRequest: reloadRequest)
    }
    static func dismantleUIView(_ view: InkReplayCanvasHost, coordinator: Void) { view.tearDown() }
}

@MainActor
final class InkReplayCanvasHost: UIView, PKCanvasViewDelegate {
    let canvas = PKCanvasView()
    private let backdrop: InkReplayBackdrop
    private let snapshot: InkReplaySnapshot
    private let replayOrder: BoardHighlighterUnderlay.ReplayOrder?
    private let initialViewport: BoardViewport?
    private let items: [BoardItem]
    private let extent: CGRect
    private let normalized: [PKStroke]
    private var displayMode: InkReplayDisplayMode = .dimmed
    private let dimmed: [PKStroke]
    private var currentCount = -1
    private var following = true
    private var overviewRequest = 0
    private var reloadRequest = 0
    private var previousSize = CGSize.zero
    private var applyingCamera = false
    private var initialized = false
    private var released = false
    private var currentFocus: InkReplayFraming.Focus?
    private var lastStatus = ""
    private var lastLocation = ""
    var onManualNavigation: (() -> Void)?
    var onStatus: ((String, String) -> Void)?

    init(snapshot: InkReplaySnapshot, items: [BoardItem], boardID: UUID, rootURL: URL?, pdfOwnerIDs: Set<UUID> = [], initialViewport: BoardViewport? = nil) {
        self.snapshot = snapshot; self.items = items; self.initialViewport = initialViewport
        replayOrder = snapshot.sourceIndices.flatMap(BoardHighlighterUnderlay.replayOrder)
        extent = InkReplayFraming.extent(ink: snapshot.bounds, items: items)
        normalized = PKDrawing(strokes: snapshot.strokes)
            .transformed(using: .init(translationX: -extent.minX, y: -extent.minY)).strokes
        dimmed = normalized.map { original in
            var stroke = original
            stroke.ink = PKInk(original.ink.inkType, color: original.ink.color.withAlphaComponent(original.ink.color.cgColor.alpha * 0.18))
            return stroke
        }
        backdrop = InkReplayBackdrop(items: items, boardID: boardID, rootURL: rootURL, pdfOwnerIDs: pdfOwnerIDs)
        super.init(frame: .zero)
        backgroundColor = .systemBackground
        backdrop.isUserInteractionEnabled = false
        addSubview(backdrop); addSubview(canvas)
        canvas.delegate = self; canvas.overrideUserInterfaceStyle = .light
        canvas.backgroundColor = .clear; canvas.isOpaque = false
        canvas.isDrawingEnabled = false; canvas.drawingPolicy = .pencilOnly
        canvas.panGestureRecognizer.minimumNumberOfTouches = 1
        canvas.contentInsetAdjustmentBehavior = .never
        canvas.minimumZoomScale = 0.00001; canvas.maximumZoomScale = 8
        canvas.showsHorizontalScrollIndicator = false; canvas.showsVerticalScrollIndicator = false
        canvas.bounces = false; canvas.bouncesZoom = false
        canvas.contentSize = extent.size
        canvas.accessibilityIdentifier = "inkReplay.viewport"
        canvas.accessibilityLabel = String(localized: "只读笔记回放，可用单指移动和双指缩放")
        canvas.panGestureRecognizer.addTarget(self, action: #selector(gestureChanged(_:)))
        canvas.pinchGestureRecognizer?.addTarget(self, action: #selector(gestureChanged(_:)))
        backdrop.onStatus = { [weak self] _ in self?.publishStatus() }
    }
    required init?(coder: NSCoder) { fatalError("Use init(snapshot:items:boardID:rootURL:)") }

    func update(count: Int, displayMode: InkReplayDisplayMode, following: Bool, overviewRequest: Int, reloadRequest: Int) {
        guard !released else { return }
        if reloadRequest != self.reloadRequest {
            self.reloadRequest = reloadRequest
            backdrop.reload()
        }
        let bounded = max(0, min(snapshot.strokes.count, count))
        let changed = bounded != currentCount
        let resumed = following && !self.following
        self.following = following
        let modeChanged = self.displayMode != displayMode
        let firstDrawing = currentCount < 0
        self.displayMode = displayMode
        currentCount = bounded
        if firstDrawing || modeChanged || changed {
            switch displayMode {
            case .progressive: canvas.drawing = replayOrder?.drawing(chronological: normalized, visibleCount: bounded) ?? PKDrawing(strokes: Array(normalized.prefix(bounded)))
            case .dimmed:
                let chronological = Array(normalized.prefix(bounded)) + Array(dimmed.dropFirst(bounded))
                canvas.drawing = replayOrder?.drawing(chronological: chronological, visibleCount: chronological.count) ?? PKDrawing(strokes: chronological)
            }
        }
        if overviewRequest != self.overviewRequest {
            self.overviewRequest = overviewRequest
            self.following = false
            showOverview()
        } else if initialized && following && (changed || resumed) {
            followCurrent(force: resumed)
        }
        publishStatus()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        let changed = bounds.size != previousSize
        let oldCenter = worldCenter
        previousSize = bounds.size
        backdrop.frame = bounds; canvas.frame = bounds
        guard bounds.width > 0, bounds.height > 0, changed else { return }
        let first = !initialized; initialized = true
        if first, let initialViewport {
            setCamera(center: CGPoint(x: initialViewport.x, y: initialViewport.y), zoom: initialViewport.zoom)
        } else if first || following { followCurrent(force: true) }
        else { setCamera(center: oldCenter, zoom: canvas.zoomScale) }
    }
    func scrollViewDidScroll(_ scrollView: UIScrollView) { updateBackdrop() }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { updateBackdrop() }
    @objc private func gestureChanged(_ gesture: UIGestureRecognizer) {
        guard gesture.state == .began, !applyingCamera, !released else { return }
        following = false
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.released else { return }
            self.onManualNavigation?()
        }
    }
    private var worldCenter: CGPoint {
        let zoom = max(0.00001, canvas.zoomScale)
        return CGPoint(x: extent.minX + (canvas.contentOffset.x + canvas.bounds.width / 2) / zoom,
                       y: extent.minY + (canvas.contentOffset.y + canvas.bounds.height / 2) / zoom)
    }
    private var visibleWorld: CGRect {
        let zoom = max(0.00001, canvas.zoomScale)
        return CGRect(x: extent.minX + canvas.contentOffset.x / zoom,
                      y: extent.minY + canvas.contentOffset.y / zoom,
                      width: bounds.width / zoom, height: bounds.height / zoom)
    }
    private func followCurrent(force: Bool) {
        guard initialized, !snapshot.strokes.isEmpty else { return }
        let index = max(0, min(snapshot.strokes.count - 1, currentCount - 1))
        let target = InkReplayFraming.focus(stroke: snapshot.strokes[index].renderBounds, items: items)
        let samePage = target.itemID != nil && target.itemID == currentFocus?.itemID
        currentFocus = target
        let interior = visibleWorld.insetBy(dx: visibleWorld.width * 0.08, dy: visibleWorld.height * 0.08)
        if !force && samePage && interior.contains(target.strokeRect) { publishStatus(); return }
        let camera = InkReplayFraming.camera(focus: target, viewport: bounds.size)
        setCamera(center: camera.center, zoom: camera.zoom)
        publishStatus()
    }
    private func showOverview() {
        guard initialized else { return }
        let content = extent.insetBy(dx: 460, dy: 460)
        let fit = min(bounds.width / max(1, content.width), bounds.height / max(1, content.height))
        setCamera(center: CGPoint(x: content.midX, y: content.midY), zoom: min(1, fit))
        publishStatus()
    }
    private func setCamera(center: CGPoint, zoom: CGFloat) {
        guard center.x.isFinite, center.y.isFinite, zoom.isFinite, zoom > 0 else { return }
        applyingCamera = true
        canvas.setZoomScale(max(canvas.minimumZoomScale, min(canvas.maximumZoomScale, zoom)), animated: false)
        let scaled = CGSize(width: extent.width * canvas.zoomScale, height: extent.height * canvas.zoomScale)
        let x = (center.x - extent.minX) * canvas.zoomScale - bounds.width / 2
        let y = (center.y - extent.minY) * canvas.zoomScale - bounds.height / 2
        canvas.contentOffset = CGPoint(x: max(0, min(max(0, scaled.width - bounds.width), x)),
                                       y: max(0, min(max(0, scaled.height - bounds.height), y)))
        applyingCamera = false
        updateBackdrop()
    }
    private func updateBackdrop() {
        guard initialized, !released, !applyingCamera else { return }
        backdrop.update(viewport: visibleWorld, zoom: canvas.zoomScale)
    }
    private func publishStatus() {
        guard !released else { return }
        let position: String
        if currentCount == 0 { position = String(localized: "尚未书写 · 点击播放开始") }
        else if following { position = currentFocus?.label ?? String(localized: "笔记局部") }
        else { position = String(localized: "自由查看 · 可重新开启跟随当前笔") }
        let status = backdrop.status
        guard position != lastLocation || status != lastStatus else { return }
        lastLocation = position; lastStatus = status
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.released else { return }
            self.onStatus?(position, status)
        }
    }
    func tearDown() {
        released = true; canvas.delegate = nil; backdrop.tearDown()
        onManualNavigation = nil; onStatus = nil
    }
}
