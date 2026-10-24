import PencilKit
import UIKit

/// Viewport-sized compositor beneath native ink. Visible pages first receive
/// small real previews; zooming refines them without clearing the overview.
@MainActor
final class BoardBackdropView: UIView {
    weak var store: BoardStore?
    var inkInteractionProbe: (() -> Bool)?
    var zoom: CGFloat = 1
    var offset = CGPoint.zero
    private var visibleItems: [BoardItem] = []
    private struct PreparedItemsKey: Equatable {
        let boardID: UUID
        let sessionID: UUID
        let previewEpoch: Int
        let revision: Int
        let updatedAt: Date
        let itemCount: Int
    }
    private var preparedItemsKey: PreparedItemsKey?
    private var preparedWorldRect = CGRect.null
    private(set) var visibilityScans = 0
    private(set) var visibilityCacheHits = 0
    private(set) var prepareVisibleItemsMaxMS: Double = 0
    private(set) var drawMaxMS: Double = 0
    private var pdfPageLayers: [UUID: BoardPDFPageLayers] = [:]
    private var layeredPDFIDs = Set<UUID>()
    private var pdfLayerOrder: [UUID] = []
    private var pdfLayerImageAssignments = 0
    private var pdfLayerPositionUpdates = 0
    private var pdfLayerContentGeneration = 0
    private static let maximumLayeredPages = 8
    private static let minimumLayeredPageSide: CGFloat = 128
    private let previewPipeline = BoardPreviewPipeline()
    private let pdfDetailPipeline = BoardPDFDetailPipeline()
    private var refreshTimer: Timer?
    private var revisionRequest: BoardPreviewCancellation?
    private var redraw: DispatchWorkItem?
    private var previewUpdate: DispatchWorkItem?
    private var previewUpdateID: UUID?
    private var redrawID: UUID?
    private var previewUpdateDelayedForInk = false
    private var redrawDelayedForInk = false
    private var previewWorkGeneration = 0
    private var previewRequestsPending = false
    private var previewDisplayPending = false
    private var lastRequestedPDFRenderScale: CGFloat?
    private static let previewBatchInterval: TimeInterval = 1.0 / 30
    private static let activeInkPreviewRetryInterval: TimeInterval = 0.2
    private var previewSession: UUID?
    private var previewEpoch = -1
    private(set) var renderedContentRevision = 0
    var onRenderedContentChange: (() -> Void)?

    var previewMetrics: BoardPreviewMetrics { previewPipeline.metrics }
    var pdfDetailMetrics: BoardPDFDetailMetrics { pdfDetailPipeline.metrics }
    func pdfDetailImages(for id: UUID) -> [(image: UIImage, rect: CGRect)] { pdfDetailPipeline.images(for: id) }
    func previewImage(for id: UUID) -> UIImage? { previewPipeline.image(for: id) }
    var pdfLayerMetrics: (pages: Int, tiles: Int, imageAssignments: Int, positionUpdates: Int) {
        (pdfPageLayers.count, pdfPageLayers.values.reduce(0) { $0 + $1.tileCount },
         pdfLayerImageAssignments, pdfLayerPositionUpdates)
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = true
        clipsToBounds = true
        contentMode = .redraw
        previewPipeline.didChange = { [weak self] in self?.previewContentDidChange() }
        pdfDetailPipeline.didChange = { [weak self] in self?.previewContentDidChange() }
    }

    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    func prepareVisibleItems(deferPreviewRequests: Bool = false) {
        let started = CACurrentMediaTime()
        defer { prepareVisibleItemsMaxMS = max(prepareVisibleItemsMaxMS, (CACurrentMediaTime() - started) * 1000) }
        guard let store, bounds.width > 0, bounds.height > 0, zoom.isFinite, zoom > 0 else { return }
        let wasPrepared = previewSession == store.canvasSessionID && previewEpoch == store.previewEpoch && !visibleItems.isEmpty
        if previewSession != store.canvasSessionID || previewEpoch != store.previewEpoch {
            invalidatePreviews(); previewSession = store.canvasSessionID; previewEpoch = store.previewEpoch
        }
        let worldVisible = CGRect(x: offset.x / zoom, y: offset.y / zoom,
                                  width: bounds.width / zoom, height: bounds.height / zoom)
        let key = PreparedItemsKey(boardID: store.document.id, sessionID: store.canvasSessionID,
            previewEpoch: store.previewEpoch, revision: store.document.revision,
            updatedAt: store.document.updatedAt, itemCount: store.document.items.count)
        let canReuse = store.mode == .ink && store.childRoot.writingPriorityEnabled
            && preparedItemsKey == key && preparedWorldRect.contains(worldVisible)
        if canReuse {
            visibilityCacheHits += 1
        } else {
            // Keep a modest neighborhood ready for the next finger move. This is
            // geometry only, never a larger bitmap or a second drawing surface.
            preparedWorldRect = store.mode == .ink && store.childRoot.writingPriorityEnabled
                ? worldVisible.insetBy(dx: -worldVisible.width / 2, dy: -worldVisible.height / 2)
                : worldVisible
            preparedItemsKey = key
            visibilityScans += 1
            visibleItems = store.document.items.filter {
                $0.canvasWorldRect.isFiniteCanvasRect && $0.canvasWorldRect.intersects(preparedWorldRect)
            }
        }
        let displayScale = window?.screen.scale ?? traitCollection.displayScale
        // The compositor is viewport-sized; its backing scale is screen density,
        // while the tile planner separately accounts for the board's zoom.
        if contentScaleFactor != displayScale { contentScaleFactor = displayScale }
        synchronizePDFPageLayers()

        let pdfScaleChanged = lastRequestedPDFRenderScale.map {
            $0 != BoardPDFDetailPipeline.renderScale(zoom: zoom, displayScale: displayScale)
        } == true && visibleItems.contains {
            $0.kind == .pdfPage && $0.sourcePath?.lowercased().hasSuffix(".pdf") == true
                && $0.canvasWorldRect.intersects(worldVisible)
                && max($0.canvasWorldRect.width, $0.canvasWorldRect.height) * zoom * displayScale > 1_024
        }
        previewRequestsPending = true
        if previewUpdateDelayedForInk && !shouldDeferPreviewWork { cancelPreviewRequestWork() }
        if shouldDeferPreviewWork {
            schedulePreviewRequests(after: Self.activeInkPreviewRetryInterval)
        } else if deferPreviewRequests && wasPrepared && !pdfScaleChanged {
            // Same-density movement keeps geometry immediate and coalesces planning.
            schedulePreviewRequests(after: Self.previewBatchInterval)
        } else {
            // A real PDF density change starts refinement without waiting for a batch.
            applyPendingPreviewRequests()
        }
        if previewDisplayPending && !shouldDeferPreviewWork && (redraw == nil || redrawDelayedForInk) {
            cancelPreviewDisplayWork()
            schedulePreviewDisplay()
        }
    }

    private var shouldDeferPreviewWork: Bool {
        guard let store else { return false }
        return store.childRoot.writingPriorityEnabled && store.canEditBoardContents
            && inkInteractionProbe?() == true
    }

    private var hasCurrentPreviewSession: Bool {
        guard let store else { return false }
        return previewSession == store.canvasSessionID && previewEpoch == store.previewEpoch
    }

    private func cancelPreviewRequestWork() {
        previewUpdate?.cancel(); previewUpdate = nil; previewUpdateID = nil
        previewUpdateDelayedForInk = false
    }

    private func cancelPreviewDisplayWork() {
        redraw?.cancel(); redraw = nil; redrawID = nil
        redrawDelayedForInk = false
    }

    private func schedulePreviewRequests(after delay: TimeInterval) {
        guard previewUpdate == nil else { return }
        let id = UUID(), generation = previewWorkGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.previewWorkGeneration == generation, self.previewUpdateID == id else { return }
            self.previewUpdate = nil; self.previewUpdateID = nil
            self.previewUpdateDelayedForInk = false
            self.applyPendingPreviewRequests()
        }
        previewUpdateID = id; previewUpdate = work
        previewUpdateDelayedForInk = delay == Self.activeInkPreviewRetryInterval
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func applyPendingPreviewRequests() {
        guard previewRequestsPending, hasCurrentPreviewSession,
              bounds.width > 0, bounds.height > 0, zoom.isFinite, zoom > 0 else { return }
        if shouldDeferPreviewWork {
            // A single low-frequency check retains work across consecutive strokes.
            schedulePreviewRequests(after: Self.activeInkPreviewRetryInterval)
            return
        }
        cancelPreviewRequestWork()
        previewRequestsPending = false
        updatePreviewRequests()
    }

    func finishViewportInteraction() {
        // Gesture completion only flushes existing requests; ink keeps its gate.
        applyPendingPreviewRequests()
    }

    func prepareForCapture() -> Bool {
        guard hasCurrentPreviewSession, bounds.isFiniteCanvasRect, bounds.width > 0, bounds.height > 0,
              offset.x.isFinite, offset.y.isFinite, zoom.isFinite, zoom > 0,
              inkInteractionProbe?() != true else { return false }
        // Callers also guard their native pan/pinch. A capture may precede the
        // queued display after the last stroke; install completed/invalidated
        // pixels without publishing a different OCR key. Retained display work
        // publishes its revision normally afterward; no decoding starts here.
        synchronizePDFPageLayers()
        setNeedsDisplay()
        return true
    }

    private func updatePreviewRequests() {
        guard let store, bounds.width > 0, bounds.height > 0, zoom.isFinite, zoom > 0 else { return }
        let worldVisible = CGRect(x: offset.x / zoom, y: offset.y / zoom,
                                  width: bounds.width / zoom, height: bounds.height / zoom)
        let center = CGPoint(x: worldVisible.midX, y: worldVisible.midY)
        let candidates = visibleItems.filter { needsPreview($0) && $0.canvasWorldRect.intersects(worldVisible) }.sorted {
            distanceSquared($0.canvasWorldRect, to: center) < distanceSquared($1.canvasWorldRect, to: center)
        }
        let displayScale = window?.screen.scale ?? traitCollection.displayScale
        lastRequestedPDFRenderScale = candidates.contains {
            $0.kind == .pdfPage && $0.sourcePath?.lowercased().hasSuffix(".pdf") == true
                && max($0.canvasWorldRect.width, $0.canvasWorldRect.height) * zoom * displayScale > 1_024
        } ? BoardPDFDetailPipeline.renderScale(zoom: zoom, displayScale: displayScale) : nil
        previewPipeline.update(items: candidates, zoom: zoom, displayScale: displayScale, store: store)
        pdfDetailPipeline.update(items: candidates, viewport: worldVisible, zoom: zoom, displayScale: displayScale, library: store.library)
        // Wanted tile regions can change without a new decode. Invalidate the
        // page content projection once per coalesced request, never per pan.
        pdfLayerContentGeneration &+= 1
        synchronizePDFPageLayers()
        if refreshTimer == nil, !candidates.isEmpty {
            let timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.checkVisibleSourceRevisions() }
            }
            refreshTimer = timer
            RunLoop.main.add(timer, forMode: .common)
            checkVisibleSourceRevisions()
        } else if candidates.isEmpty {
            refreshTimer?.invalidate(); refreshTimer = nil
            revisionRequest?.cancel(); revisionRequest = nil
        }
    }

    private func needsPreview(_ item: BoardItem) -> Bool {
        if BoardVideo.isVideo(item) { return false }
        if item.kind == .text || item.kind == .formula { return item.usesFormulaRendering || item.usesRichTextRendering }
        return item.kind == .document || item.kind == .pdfPage || item.kind == .inkGroup
    }

    private func checkVisibleSourceRevisions() {
        // The existing three-second timer will retry after the native pen is quiet.
        guard !shouldDeferPreviewWork, hasCurrentPreviewSession,
              revisionRequest == nil, let library = store?.library else { return }
        let paths = Set(visibleItems.filter(needsPreview).compactMap(\.sourcePath))
        guard !paths.isEmpty else { return }
        let token = BoardPreviewCancellation(); revisionRequest = token
        library.viewportSourceRevisions(paths: paths, token: token) { [weak self] values in
            guard let self, self.hasCurrentPreviewSession, self.revisionRequest === token, !token.isCancelled else { return }
            self.revisionRequest = nil
            self.previewPipeline.sourceRevisions(values)
            self.pdfDetailPipeline.sourceRevisions(values)
        }
    }

    private func previewContentDidChange() {
        // Invalidate immediately, before the batched display callback: capture
        // and scroll must never reuse a source-invalidated or completed image.
        pdfLayerContentGeneration &+= 1
        schedulePreviewDisplay()
    }

    private func schedulePreviewDisplay() {
        previewDisplayPending = true
        guard redraw == nil else { return }
        let id = UUID(), generation = previewWorkGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.previewWorkGeneration == generation, self.redrawID == id else { return }
            self.redraw = nil; self.redrawID = nil
            self.redrawDelayedForInk = false
            guard self.previewDisplayPending, self.hasCurrentPreviewSession,
                  self.bounds.width > 0, self.bounds.height > 0 else { return }
            if self.shouldDeferPreviewWork {
                self.schedulePreviewDisplay()
                return
            }
            self.previewDisplayPending = false
            self.renderedContentRevision &+= 1
            // Pixel generations changed immediately; publish them only after ink is quiet.
            self.synchronizePDFPageLayers()
            self.setNeedsDisplay()
            self.onRenderedContentChange?()
        }
        redrawID = id; redraw = work
        redrawDelayedForInk = shouldDeferPreviewWork
        let delay = redrawDelayedForInk ? Self.activeInkPreviewRetryInterval : Self.previewBatchInterval
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func releasePreviews() {
        invalidatePreviews(); visibleItems.removeAll(); store = nil; inkInteractionProbe = nil
    }

    func invalidatePreviews() {
        preparedItemsKey = nil
        preparedWorldRect = .null
        refreshTimer?.invalidate(); refreshTimer = nil
        revisionRequest?.cancel(); revisionRequest = nil
        previewWorkGeneration &+= 1
        cancelPreviewDisplayWork()
        cancelPreviewRequestWork()
        previewDisplayPending = false; previewRequestsPending = false
        lastRequestedPDFRenderScale = nil
        previewPipeline.reset()
        pdfDetailPipeline.reset()
        releasePDFPageLayers()
    }

    func retryPendingPreviews() {
        // Legacy formula/inspector notifications do not discard viewport images.
        prepareVisibleItems()
    }

    override func draw(_ rect: CGRect) {
        let started = CACurrentMediaTime()
        defer { drawMaxMS = max(drawMaxMS, (CACurrentMediaTime() - started) * 1000) }
        guard let store, let context = UIGraphicsGetCurrentContext() else { return }
        (backgroundColor ?? .white).setFill()
        context.fill(bounds)
        drawGrid(in: context)
        drawEdges(store, in: context)
        for item in visibleItems where !layeredPDFIDs.contains(item.id) {
            let frame = screenRect(item.canvasWorldRect)
            guard frame.intersects(bounds), frame.width > 0, frame.height > 0 else { continue }
            drawCard(item, frame: frame, selected: store.selectedIDs.contains(item.id), context: context)
        }
        drawPins(store, in: context)
        drawPrintFrames(store, in: context)
    }

    /// Isolated PDF images can move in Core Animation without replaying a
    /// viewport-sized CGContext image resample on every finger-drag event.
    /// All overlap/decorated/unsupported cases keep the original painter path.
    private func synchronizePDFPageLayers() {
        guard let store, bounds.width > 0, bounds.height > 0, zoom.isFinite, zoom > 0 else {
            releasePDFPageLayers(); return
        }
        let visiblePin = store.document.pins.contains { pin in
            bounds.insetBy(dx: -30, dy: -30).contains(CGPoint(x: CGFloat(pin.x) * zoom - offset.x,
                                                           y: CGFloat(pin.y) * zoom - offset.y))
        }
        // Pins/print frames are drawn after every card. Keeping their existing
        // CGContext route avoids changing that ordering or their label bounds.
        guard !visiblePin, !(store.showsPrintFrames && !store.printFrames.isEmpty) else {
            releasePDFPageLayers(); return
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        // Project each visible card once. The original overlap rule used the
        // same projection repeatedly for every PDF page and neighboring card.
        let cards = visibleItems.compactMap { item -> (item: BoardItem, frame: CGRect, occupied: CGRect)? in
            let frame = screenRect(item.canvasWorldRect)
            guard frame.intersects(bounds) else { return nil }
            let stroke: CGFloat
            if store.selectedIDs.contains(item.id) { stroke = 2.5 }
            else if item.style != nil, item.kind == .text || item.kind == .formula {
                stroke = item.style?.strokeWidth.map { max(0.25, CGFloat($0) * zoom) } ?? 1
            } else { stroke = 1 }
            let padding = max(0.125, stroke / 2)
            return (item, frame, frame.insetBy(dx: -padding, dy: -padding))
        }
        var next: [UUID] = []
        for card in cards where card.item.kind == .pdfPage {
            let item = card.item, frame = card.frame
            guard frame.width >= Self.minimumLayeredPageSide, frame.height >= Self.minimumLayeredPageSide else { continue }
            let pageBorder: CGFloat = store.selectedIDs.contains(item.id) ? 1.25 : 0.5
            let occupied = frame.insetBy(dx: -pageBorder, dy: -pageBorder)
            guard !cards.contains(where: { $0.item.id != item.id && occupied.intersects($0.occupied) }) else { continue }
            let page: BoardPDFPageLayers
            if let existing = pdfPageLayers[item.id],
               !existing.needsContentUpdate(generation: pdfLayerContentGeneration, worldRect: item.canvasWorldRect) {
                // A finger pan changes only the container's translation. Keep
                // existing tile pixels/order/local geometry out of the hot path.
                page = existing
            } else {
                guard let overview = previewPipeline.image(for: item.id), overview.imageOrientation == .up,
                      let overviewImage = overview.cgImage else { continue }
                let details = pdfDetailPipeline.images(for: item.id)
                guard details.allSatisfy({ $0.image.imageOrientation == .up && $0.image.cgImage != nil }) else { continue }
                if let existing = pdfPageLayers[item.id] { page = existing }
                else {
                    page = BoardPDFPageLayers()
                    pdfPageLayers[item.id] = page
                    layer.addSublayer(page.container)
                }
                pdfLayerImageAssignments += page.updateContents(overview: overviewImage, details: details,
                    generation: pdfLayerContentGeneration, worldRect: item.canvasWorldRect)
            }
            pdfLayerPositionUpdates += page.updateGeometry(frame: frame, worldRect: item.canvasWorldRect, zoom: zoom,
                displayScale: contentScaleFactor, selected: store.selectedIDs.contains(item.id))
            next.append(item.id)
            if next.count == Self.maximumLayeredPages { break }
        }
        let retained = Set(next)
        for id in Array(pdfPageLayers.keys) where !retained.contains(id) {
            pdfPageLayers.removeValue(forKey: id)?.release()
        }
        if next != pdfLayerOrder {
            // Use document order, never the center-first preview request order.
            for id in next { if let page = pdfPageLayers[id] { layer.addSublayer(page.container) } }
            pdfLayerOrder = next
        }
        layeredPDFIDs = retained
    }

    private func releasePDFPageLayers() {
        for page in pdfPageLayers.values { page.release() }
        pdfPageLayers.removeAll()
        layeredPDFIDs.removeAll()
        pdfLayerOrder.removeAll()
    }

    private func drawPrintFrames(_ store: BoardStore, in context: CGContext) {
        guard store.showsPrintFrames else { return }
        for (index, page) in store.printFrames.enumerated() {
            let content = screenRect(page.rect)
            let margin = PrintPageGeometry.margin / page.pdfScale * zoom
            let paper = content.insetBy(dx: -margin, dy: -margin)
            guard paper.intersects(bounds), paper.width > 2 else { continue }
            let selected = store.mode == .paper && store.selectedPrintFrameID == page.id
            context.saveGState()
            context.setStrokeColor((selected ? UIColor.systemIndigo : UIColor.systemIndigo.withAlphaComponent(0.65)).cgColor)
            context.setLineWidth(selected ? 2.5 : 1)
            context.stroke(paper)
            context.setLineDash(phase: 0, lengths: [5, 4])
            context.setStrokeColor(UIColor.systemIndigo.withAlphaComponent(0.45).cgColor)
            context.stroke(content)
            if let clip = page.normalizedClip, clip.width < 0.99999 || clip.height < 0.99999 || clip.minX > 0 || clip.minY > 0 {
                let selectedContent = screenRect(page.clippedSourceRect)
                context.setLineDash(phase: 0, lengths: [2, 3])
                context.setStrokeColor(UIColor.systemOrange.withAlphaComponent(0.8).cgColor)
                context.stroke(selectedContent)
            }
            context.setLineDash(phase: 0, lengths: [])
            if paper.width >= 44 {
                let label = "\(index + 1)"
                let attributes: [NSAttributedString.Key: Any] = [
                    .font: UIFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
                    .foregroundColor: UIColor.systemIndigo,
                    .backgroundColor: UIColor.systemBackground.withAlphaComponent(0.85)]
                let size = (label as NSString).size(withAttributes: attributes)
                (label as NSString).draw(at: CGPoint(x: paper.midX - size.width / 2,
                    y: content.maxY + max(2, (margin - size.height) / 2)), withAttributes: attributes)
            }
            context.restoreGState()
        }
    }

    private func drawGrid(in context: CGContext) {
        var step: CGFloat = 40 * zoom
        while step < 24 { step *= 5 }
        while step > 160 { step /= 5 }
        context.setFillColor(UIColor.black.withAlphaComponent(0.12).cgColor)
        let startX = (-offset.x).truncatingRemainder(dividingBy: step)
        let startY = (-offset.y).truncatingRemainder(dividingBy: step)
        for x in stride(from: startX, through: bounds.width, by: step) {
            for y in stride(from: startY, through: bounds.height, by: step) {
                context.fillEllipse(in: CGRect(x: x, y: y, width: 1.4, height: 1.4))
            }
        }
    }

    private func drawEdges(_ store: BoardStore, in context: CGContext) {
        guard !store.document.edges.isEmpty else { return }
        let byID = Dictionary(store.document.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        context.setStrokeColor(UIColor.systemTeal.withAlphaComponent(0.72).cgColor)
        context.setLineWidth(max(1, min(3, 2 * zoom)))
        for edge in store.document.edges {
            guard let source = byID[edge.from], let target = byID[edge.to] else { continue }
            let a = screenRect(source.canvasWorldRect)
            let b = screenRect(target.canvasWorldRect)
            let sourcePoint = CGPoint(x: a.midX, y: a.midY)
            let targetPoint = CGPoint(x: b.midX, y: b.midY)
            let horizontal = abs(targetPoint.x - sourcePoint.x) >= abs(targetPoint.y - sourcePoint.y)
            let start = horizontal ? CGPoint(x: targetPoint.x >= sourcePoint.x ? a.maxX : a.minX, y: a.midY)
                                   : CGPoint(x: a.midX, y: targetPoint.y >= sourcePoint.y ? a.maxY : a.minY)
            let end = horizontal ? CGPoint(x: targetPoint.x >= sourcePoint.x ? b.minX : b.maxX, y: b.midY)
                                 : CGPoint(x: b.midX, y: targetPoint.y >= sourcePoint.y ? b.minY : b.maxY)
            context.saveGState()
            BoardStyledDrawing.edgeStyle(edge, scale: zoom, context: context)
            let midX = (start.x + end.x) / 2
            let midY = (start.y + end.y) / 2
            context.move(to: start)
            context.addCurve(to: end,
                             control1: horizontal ? CGPoint(x: midX, y: start.y) : CGPoint(x: start.x, y: midY),
                             control2: horizontal ? CGPoint(x: midX, y: end.y) : CGPoint(x: end.x, y: midY))
            context.strokePath()
            context.setLineDash(phase: 0, lengths: [])
            if let arrow = edge.style?.arrow, arrow != .none {
                let endControl = horizontal ? CGPoint(x: midX, y: end.y) : CGPoint(x: end.x, y: midY)
                let startControl = horizontal ? CGPoint(x: midX, y: start.y) : CGPoint(x: start.x, y: midY)
                BoardStyledDrawing.arrow(at: end, from: endControl, scale: zoom, context: context)
                if arrow == .both { BoardStyledDrawing.arrow(at: start, from: startControl, scale: zoom, context: context) }
            }
            BoardStyledDrawing.relation(edge.relation, at: CGPoint(x: midX, y: midY), scale: zoom)
            context.restoreGState()
        }
    }

    private func drawCard(_ item: BoardItem, frame: CGRect, selected: Bool, context: CGContext) {
        if item.style != nil, item.kind == .text || item.kind == .formula {
            BoardStyledDrawing.card(item, frame: frame, scale: zoom, selected: selected,
                                    formula: previewPipeline.image(for: item.id), richTextFailed: previewPipeline.hasFailed(for:item.id), context: context)
            return
        }
        context.saveGState()
        // PDF page content is exactly item.rect, independent of zoom. This is also
        // the coordinate contract used by original-PDF annotation writeback.
        if item.kind == .pdfPage || item.kind == .inkGroup || item.usesBoardNotesImageBounds {
            UIColor.white.setFill()
            context.fill(frame)
            context.saveGState()
            context.clip(to: frame)
            if let preview = previewPipeline.image(for: item.id) { preview.draw(in: frame) }
            else if frame.width >= 64 {
                (item.title as NSString).draw(in: frame.insetBy(dx: 8, dy: 8),
                    withAttributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: UIColor.secondaryLabel])
            }
            if item.kind == .pdfPage {
                // Draw full-density vector tiles over the retained overview.
                // These rects use the same page coordinates as native ink and PDF writeback.
                for tile in pdfDetailPipeline.images(for: item.id) { tile.image.draw(in: screenRect(tile.rect)) }
            }
            context.restoreGState()
            context.setStrokeColor((selected ? UIColor.systemTeal : UIColor.black.withAlphaComponent(0.13)).cgColor)
            context.setLineWidth(selected ? 2.5 : 1)
            context.stroke(frame)
            context.restoreGState()
            return
        }
        let radius = min(12, 8 * zoom)
        let path = UIBezierPath(roundedRect: frame, cornerRadius: radius)
        UIColor.white.setFill()
        path.fill()
        (selected ? UIColor.systemTeal : UIColor.black.withAlphaComponent(0.13)).setStroke()
        path.lineWidth = selected ? 2.5 : 1
        path.stroke()
        path.addClip()
        // At overview scale, use the whole card for the real preview; labels wait
        // until they have enough room to be useful.
        guard frame.width >= 24, frame.height >= 18 else {
            if let preview = previewPipeline.image(for: item.id) { preview.draw(in: frame) }
            context.restoreGState(); return
        }
        let inset = min(14, max(3, 12 * zoom))
        let titleHeight = min(34, max(12, 28 * zoom))
        UIColor(red: 0.95, green: 0.97, blue: 0.96, alpha: 1).setFill()
        context.fill(CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: titleHeight))
        let titleFont = UIFont.systemFont(ofSize: min(18, max(7, 13 * zoom)), weight: .semibold)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byTruncatingTail
        (item.title as NSString).draw(in: CGRect(x: frame.minX + inset, y: frame.minY + 3,
                                                 width: max(0, frame.width - inset * 2), height: titleHeight - 3),
                                     withAttributes: [.font: titleFont, .foregroundColor: UIColor.darkGray, .paragraphStyle: paragraph])
        let content = CGRect(x: frame.minX + inset, y: frame.minY + titleHeight + inset,
                             width: max(0, frame.width - 2 * inset),
                             height: max(0, frame.height - titleHeight - 2 * inset))
        if let preview = previewPipeline.image(for: item.id), content.width > 0, content.height > 0 {
            let scale = min(content.width / max(preview.size.width, 1), content.height / max(preview.size.height, 1))
            let size = CGSize(width: preview.size.width * scale, height: preview.size.height * scale)
            preview.draw(in: CGRect(x: content.midX - size.width / 2, y: content.minY, width: size.width, height: size.height))
        } else if frame.width >= 64, frame.height >= 48 {
            let text: String
            switch item.kind {
            case .formula: text = item.text ?? "LaTeX"
            case .text: text = (previewPipeline.hasFailed(for:item.id) ? String(localized:"表格预览暂不可用，原内容已保留。") + "\n" : "") + (item.text ?? "")
            case .inkGroup: text = String(localized: "手写节点")
            case .pdfPage: text = String(localized: "第 \(item.page ?? 1) 页")
            case .document: text = BoardVideo.isVideo(item) ? String(localized: "视频 · 轻点播放按钮，或打开独立播放器") : item.sourcePath ?? String(localized: "文档")
            }
            let font: UIFont = item.usesMonospacedText
                ? .monospacedSystemFont(ofSize: min(24, max(9, 16 * zoom)), weight: .regular)
                : .systemFont(ofSize: min(24, max(9, 16 * zoom)))
            (text as NSString).draw(in: content, withAttributes: [.font: font, .foregroundColor: UIColor.darkGray])
        }
        context.restoreGState()
    }

    private func drawPins(_ store: BoardStore, in context: CGContext) {
        for pin in store.document.pins {
            let point = CGPoint(x: CGFloat(pin.x) * zoom - offset.x, y: CGFloat(pin.y) * zoom - offset.y)
            guard bounds.insetBy(dx: -30, dy: -30).contains(point) else { continue }
            context.setFillColor(UIColor.systemOrange.cgColor)
            context.fillEllipse(in: CGRect(x: point.x - 6, y: point.y - 6, width: 12, height: 12))
            (pin.title as NSString).draw(at: CGPoint(x: point.x + 10, y: point.y - 7),
                                        withAttributes: [.font: UIFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: UIColor.darkGray])
        }
    }

    private func screenRect(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX * zoom - offset.x, y: rect.minY * zoom - offset.y,
               width: rect.width * zoom, height: rect.height * zoom)
    }

    private func distanceSquared(_ rect: CGRect, to point: CGPoint) -> CGFloat {
        let dx = rect.midX - point.x
        let dy = rect.midY - point.y
        return dx * dx + dy * dy
    }
}


/// A page uses the original source pixels. Its local geometry is independent
/// of viewport translation; only the container moves when the finger pans.
@MainActor
private final class BoardPDFPageLayers {
    let container = CALayer()
    private let clippedPage = CALayer()
    private let overviewLayer = CALayer()
    private let border = CAShapeLayer()
    private var overviewImage: CGImage?
    private struct TileKey: Hashable {
        let x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat
        init(_ rect: CGRect) { x = rect.minX; y = rect.minY; width = rect.width; height = rect.height }
    }
    private struct Tile {
        let layer: CALayer
        var image: CGImage
        let worldRect: CGRect
    }
    private var tiles: [TileKey: Tile] = [:]
    private var tileOrder: [TileKey] = []
    private var contentGeneration: Int?
    private var contentWorldRect = CGRect.null
    private var geometryWorldRect = CGRect.null
    private var geometryZoom: CGFloat = 0
    private var selected: Bool?
    var tileCount: Int { tiles.count }

    init() {
        container.masksToBounds = false
        clippedPage.masksToBounds = true
        clippedPage.backgroundColor = UIColor.white.cgColor
        container.addSublayer(clippedPage)
        clippedPage.addSublayer(overviewLayer)
        overviewLayer.contentsGravity = .resize
        border.fillColor = nil
        container.addSublayer(border)
    }

    func needsContentUpdate(generation: Int, worldRect: CGRect) -> Bool {
        contentGeneration != generation || contentWorldRect != worldRect
    }

    func updateContents(overview: CGImage, details: [(image: UIImage, rect: CGRect)],
                        generation: Int, worldRect: CGRect) -> Int {
        var imageAssignments = 0
        if overviewImage !== overview {
            overviewImage = overview
            overviewLayer.contents = overview
            imageAssignments += 1
        }
        var next: [TileKey] = [], wanted = Set<TileKey>()
        for detail in details {
            guard let image = detail.image.cgImage else { continue }
            let key = TileKey(detail.rect)
            // If fallback and current detail share a rect, the latter is the
            // final image, and its key belongs at the end of the paint order.
            if !wanted.insert(key).inserted { next.removeAll { $0 == key } }
            next.append(key)
            if var existing = tiles[key] {
                if existing.image !== image {
                    existing.image = image; tiles[key] = existing
                    existing.layer.contents = image; imageAssignments += 1
                }
            } else {
                let tile = CALayer()
                tile.contentsGravity = .resize
                tile.contents = image
                tiles[key] = Tile(layer: tile, image: image, worldRect: detail.rect)
                clippedPage.addSublayer(tile)
                imageAssignments += 1
            }
        }
        for key in Array(tiles.keys) where !wanted.contains(key) {
            if let old = tiles.removeValue(forKey: key) { old.layer.contents = nil; old.layer.removeFromSuperlayer() }
        }
        if next != tileOrder {
            // Cached tiles may switch from fallback to exact-scale roles.
            // Preserve the pipeline's paint order even when layers already exist.
            for key in next { if let tile = tiles[key] { clippedPage.addSublayer(tile.layer) } }
            tileOrder = next
        }
        contentGeneration = generation
        contentWorldRect = worldRect
        // New or replaced local rectangles must be projected once, even when
        // the viewport size/zoom stayed unchanged while decoding completed.
        geometryWorldRect = .null
        return imageAssignments
    }

    @discardableResult
    func updateGeometry(frame: CGRect, worldRect: CGRect, zoom: CGFloat,
                        displayScale: CGFloat, selected: Bool) -> Int {
        var positionUpdates = 0
        if container.frame != frame { container.frame = frame; positionUpdates += 1 }
        let resized = container.bounds.size != clippedPage.bounds.size
        let localBounds = CGRect(origin: .zero, size: frame.size)
        if resized || geometryWorldRect != worldRect || geometryZoom != zoom {
            if clippedPage.frame != localBounds { clippedPage.frame = localBounds }
            if overviewLayer.frame != localBounds { overviewLayer.frame = localBounds }
            if border.frame != localBounds { border.frame = localBounds }
            for tile in tiles.values {
                // PDFKit has already applied crop/rotation. No viewport offset,
                // second rotation, or y flip belongs in this local projection.
                let local = Self.localTileRect(tile.worldRect, page: worldRect, zoom: zoom)
                if tile.layer.frame != local { tile.layer.frame = local }
            }
            border.path = CGPath(rect: localBounds, transform: nil)
            geometryWorldRect = worldRect
            geometryZoom = zoom
        }
        if border.contentsScale != displayScale { border.contentsScale = displayScale }
        if self.selected != selected {
            self.selected = selected
            border.strokeColor = (selected ? UIColor.systemTeal : UIColor.black.withAlphaComponent(0.13)).cgColor
            border.lineWidth = selected ? 2.5 : 1
        }
        return positionUpdates
    }

    static func localTileRect(_ tile: CGRect, page: CGRect, zoom: CGFloat) -> CGRect {
        CGRect(x: (tile.minX - page.minX) * zoom, y: (tile.minY - page.minY) * zoom,
               width: tile.width * zoom, height: tile.height * zoom)
    }

    func release() {
        overviewLayer.contents = nil
        overviewImage = nil
        for tile in tiles.values { tile.layer.contents = nil; tile.layer.removeFromSuperlayer() }
        tiles.removeAll()
        tileOrder.removeAll()
        contentGeneration = nil
        contentWorldRect = .null
        geometryWorldRect = .null
        geometryZoom = 0
        container.removeFromSuperlayer()
    }
}
