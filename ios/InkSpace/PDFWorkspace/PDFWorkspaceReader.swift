import PDFKit
import SwiftUI
import UIKit
import PencilKit

/// PDFKit remains a reader. Marks are painted in a separate, noninteractive
/// page overlay that shares PDFKit’s scrolling and zooming view hierarchy.
struct PDFWorkspaceReader: UIViewRepresentable {
    let pane: PDFWorkspacePane
    @Environment(\.openURL) private var openURL
    func makeUIView(context: Context) -> PDFWorkspaceReaderHost {
        let host = PDFWorkspaceReaderHost(pane: pane); host.onOpenURL = { openURL($0) }; return host
    }
    func updateUIView(_ view: PDFWorkspaceReaderHost, context: Context) { view.onOpenURL = { openURL($0) }; view.synchronize() }
    static func dismantleUIView(_ view: PDFWorkspaceReaderHost, coordinator: ()) { view.tearDown() }
}

final class PDFWorkspaceTraceGesture: UIGestureRecognizer {
    private(set) var position = CGPoint.zero
    private var tracked: UITouch?
    var tracksPencil: Bool { tracked?.type == .pencil }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard tracked == nil, touches.count == 1, let touch = touches.first else {
            state = state == .began || state == .changed ? .cancelled : .failed; return
        }
        tracked = touch; position = touch.location(in: view); state = .began
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let tracked, touches.contains(tracked) else { return }
        position = tracked.location(in: view); state = .changed
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let tracked, touches.contains(tracked) else { return }
        position = tracked.location(in: view); state = .ended
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .cancelled }
    override func reset() { tracked = nil; super.reset() }
}

@MainActor final class PDFWorkspaceReaderHost: UIView, UIGestureRecognizerDelegate, PDFViewDelegate, PDFPageOverlayViewProvider {
    var onOpenURL: ((URL) -> Void)?
    let pdfView = PDFView()
    let pane: PDFWorkspacePane
    private var pagePaints: [ObjectIdentifier: PDFWorkspacePaintView] = [:]
    private var marks: [Int: [PDFWorkspaceAnnotation]] = [:]
    private var futureIDs: Set<UUID> = []
    private var draft: PDFWorkspaceAnnotation?
    private var trace: PDFWorkspaceTraceGesture!
    private var readingPinch: UIPinchGestureRecognizer!
    private var originalPinches: [(UIPinchGestureRecognizer, Bool)] = []
    private var pinchScale: CGFloat = 1
    private var pinchPage: PDFPage?
    private var pinchPoint = CGPoint.zero
    private var displayLink: CADisplayLink?
    private var pulseTarget: PDFWorkspacePulseTarget?
    private var tornDown=false
    private var loaded: PDFDocument?
    private var paintedRevision = -1
    private var lastReadAloudPage = -1
    private var lastReadAloudRect: CGRect?
    private var strokePage: PDFPage?
    private var points: [[Double]] = []
    private var draftTool: PDFWorkspaceTool = .read
    private var sourceAtStart = ""
    private var layerAtStart: UUID?
    private var sourcePageAtStart = 1
    private var inlineTextSelection: BoardInlineTextSelection!
    private weak var analysisPage: PDFPage?
    private var analysisPageHasText = false
    private weak var explicitOCRPage: PDFPage?
    private var selectionScrollViews: [(UIScrollView, Int)] = []
    private var nativeInkActive:Bool {pagePaints.values.contains{$0.inkActive}}
    init(pane: PDFWorkspacePane) {
        self.pane = pane; super.init(frame: .zero)
        pdfView.delegate = self
        pdfView.pageOverlayViewProvider = self
        pdfView.autoScales = true; pdfView.displayMode = .singlePageContinuous; pdfView.displayDirection = .vertical
        pdfView.backgroundColor = .secondarySystemBackground
        pdfView.accessibilityIdentifier = "pdfWorkspace.reader"
        addSubview(pdfView)
        trace = PDFWorkspaceTraceGesture(target: self, action: #selector(traceChanged(_:)))
        trace.cancelsTouchesInView = true; trace.name = "pdfWorkspace.annotation"
        trace.delegate = self
        pdfView.addGestureRecognizer(trace)
        readingPinch = UIPinchGestureRecognizer(target: self, action: #selector(pinchChanged(_:)))
        readingPinch.name = "pdfWorkspace.pinch"; readingPinch.delegate = self
        readingPinch.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        readingPinch.cancelsTouchesInView = false; addGestureRecognizer(readingPinch)
        pane.pdfView = pdfView; pane.captureSource.view = pdfView
        pane.textSelectionHost = self
        NotificationCenter.default.addObserver(self, selector: #selector(nativeTextSelectionChanged),
            name: .PDFViewSelectionChanged, object: pdfView)
        inlineTextSelection = BoardInlineTextSelection(content: pdfView)
        inlineTextSelection.capture = { [weak self] key in self?.captureTextSelection(key) }
        inlineTextSelection.canInteract = { [weak self] point in
            guard let self, self.textSelectionKey != nil, !self.textSelectionGestureActive,
                  let page = self.pdfView.page(for: point, nearest: false) else { return false }
            return page === self.analysisPage
        }
        inlineTextSelection.onStatus = { [weak self] status in
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.tornDown, self.inlineTextSelection.currentStatus == status else { return }
                self.pane.textSelectionStatus = status.replacingOccurrences(of: "白板", with: "页面")
            }
        }
        inlineTextSelection.onSelectionChanged = { [weak self] _ in
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.tornDown else { return }
                // PDFKit and Live Text share this view. Clearing PDFKit here
                // can dismiss the active Live Text selection and Copy menu.
                // Explicit copy resolves the current OCR selection first.
                self.synchronizeSelectionNavigation()
            }
        }
        let target = PDFWorkspacePulseTarget(); target.host = self; pulseTarget = target
        displayLink = CADisplayLink(target: target, selector: #selector(PDFWorkspacePulseTarget.tick))
        displayLink?.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
        displayLink?.add(to: .main, forMode: .common)
        synchronize()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() { super.layoutSubviews(); pdfView.frame = bounds; preparePinch(); tick() }
    private func preparePinch() {
        // Own one recognizer at the host boundary, where SwiftUI annotation
        // overlays cannot reset PDFKit's internal recognizer during a pinch.
        // Disable only the nested built-in pinches to prevent double scaling.
        func inspect(_ view: UIView) {
            for gesture in view.gestureRecognizers ?? [] {
                if let pinch = gesture as? UIPinchGestureRecognizer, !originalPinches.contains(where: { $0.0 === pinch }) {
                    originalPinches.append((pinch,pinch.isEnabled)); pinch.isEnabled = false
                }
            }
            view.subviews.forEach(inspect)
        }
        inspect(pdfView)
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        gestureRecognizer === readingPinch || other === readingPinch
    }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === readingPinch {
            if nativeInkActive {return false}
            if trace.tracksPencil && (trace.state == .began || trace.state == .changed) { return false }
            return pdfView.document != nil && !pane.isLoading && !pane.isSaving && !pane.hasPendingWrite && pane.textDraft == nil && !pane.temporaryTranslation.capture.isSelecting && !pane.imageExcerptActive
        }
        return true
    }
    @objc private func pinchChanged(_ gesture: UIPinchGestureRecognizer) {
        let location = gesture.location(in: pdfView)
        switch gesture.state {
        case .began:
            if trace.state == .began || trace.state == .changed { trace.isEnabled = false; cancelDraft() }
            pinchScale = pdfView.scaleFactor; pinchPage = pdfView.page(for: location, nearest: true)
            if let page = pinchPage { pinchPoint = pdfView.convert(location, to: page) }
            pane.interactionActive = true
        case .changed:
            guard let page = pinchPage, page.document === pdfView.document else { return }
            let fit = pdfView.scaleFactorForSizeToFit
            let minimum = max(0.05, min(1, fit.isFinite && fit > 0 ? fit*0.3 : 0.1))
            let maximum = min(12, max(5, fit.isFinite && fit > 0 ? fit*6 : 5))
            pdfView.autoScales = false; pdfView.minScaleFactor = minimum; pdfView.maxScaleFactor = maximum
            pdfView.scaleFactor = min(maximum, max(minimum, pinchScale*gesture.scale))
            pdfView.layoutDocumentView()
            let anchored = pdfView.convert(pinchPoint, from: page)
            var ancestor = pdfView.documentView?.superview
            while let view = ancestor {
                if let scroll = view as? UIScrollView {
                    let target = CGPoint(x:scroll.contentOffset.x+anchored.x-location.x,y:scroll.contentOffset.y+anchored.y-location.y)
                    let inset = scroll.adjustedContentInset
                    let maximumX = max(-inset.left,scroll.contentSize.width-scroll.bounds.width+inset.right)
                    let maximumY = max(-inset.top,scroll.contentSize.height-scroll.bounds.height+inset.bottom)
                    scroll.contentOffset = CGPoint(x:min(maximumX,max(-inset.left,target.x)),y:min(maximumY,max(-inset.top,target.y)));break
                }
                ancestor = view.superview
            }
            tick()
        case .ended, .cancelled, .failed:
            pinchPage = nil; pane.interactionActive = false; synchronize(); tick()
        default: break
        }
    }
    func synchronize() {
        if loaded !== pane.document {
            let desiredZoom=pane.zoom,desiredPage=pane.page
            let requested=pane.document
            loaded=requested
            // PDFKit may change first responder while assigning its document.
            // Defer outside SwiftUI's updateUIView/AttributeGraph transaction to
            // avoid a reentrant graph cycle. Only the newest document wins.
            DispatchQueue.main.async { [weak self, weak requested] in
                guard let self,self.loaded === requested,self.pane.document === requested,!self.tornDown else{return}
                self.pagePaints.removeAll()
                self.pdfView.document=requested;self.pane.captureSource.snapshotSessionID=UUID()
                guard let target=requested?.page(at:max(0,desiredPage-1)) else{return}
                self.pdfView.layoutDocumentView()
                if desiredZoom>0 {self.pdfView.autoScales=false;self.pdfView.scaleFactor=min(self.pdfView.maxScaleFactor,max(self.pdfView.minScaleFactor,desiredZoom))}
                self.pdfView.go(to:target)
                if let reference=self.pane.pendingSourceReference {self.pane.locateSourceReference(reference)}
            }
        }
        if paintedRevision != pane.revision {
            paintedRevision = pane.revision
            let order = Dictionary(uniqueKeysWithValues: pane.projection.layers.enumerated().map { ($0.element.id,$0.offset) })
            marks = Dictionary(grouping: pane.displayedAnnotations.sorted { order[$0.layerID, default: 0] < order[$1.layerID, default: 0] }, by: \.page)
            futureIDs = pane.futureReplayIDs
            refreshPagePaints()
        }
        if trace.state != .began && trace.state != .changed {
            trace.isEnabled = readingPinch.state != .began && readingPinch.state != .changed && pane.tool != .read && pane.tool != .ink && pane.canAnnotate && !pane.temporaryTranslation.capture.isSelecting && !pane.imageExcerptActive
            trace.allowedTouchTypes = pane.tool == .ink ? [NSNumber(value: UITouch.TouchType.pencil.rawValue)] : [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        }
        pagePaints.values.forEach(configureNativeInput)
        synchronizeTextSelection()
    }
    func tick() {
        guard window != nil else { return }
        var navigating = false
        func inspect(_ view: UIView) {
            if let scroll = view as? UIScrollView, scroll.isTracking || scroll.isDragging || scroll.isDecelerating || scroll.isZooming { navigating = true }
            for child in view.subviews { inspect(child) }
        }
        inspect(pdfView)
        let drawing = nativeInkActive || trace.state == .began || trace.state == .changed || readingPinch.state == .began || readingPinch.state == .changed
        let active = navigating || drawing
        if pane.interactionActive != active {
            pane.interactionActive = active
            if !active && pane.needsRefresh { Task { await pane.refresh() } }
        }
        if let document = pdfView.document, let page = pdfView.currentPage {
            let index = document.index(for: page)+1
            if pane.page != index { pane.page = index }
        }
        if pdfView.document != nil { pane.zoom = pdfView.scaleFactor }
        if lastReadAloudPage != pane.readAloudPage || lastReadAloudRect != pane.readAloudRect {
            lastReadAloudPage = pane.readAloudPage; lastReadAloudRect = pane.readAloudRect
            refreshPagePaints()
        }
        synchronizeTextSelection()
    }
    private var textSelectionKey: BoardTextSelectionSnapshotKey? {
        guard !tornDown, window != nil, !pane.extensionMode, !pane.layerReplayActive,
              !pane.isLoading, !pane.isSaving, !pane.hasPendingWrite, pane.textDraft == nil,
              !pane.temporaryTranslation.capture.isSelecting, !pane.imageExcerptActive,
              pane.tool == .read || (pane.tool == .ink && pdfView.currentPage === explicitOCRPage),
              !nativeInkActive,
              trace.state != .began, trace.state != .changed,
              let page = pdfView.currentPage, page === analysisPage, !analysisPageHasText || page === explicitOCRPage,
              let document = pdfView.document, document === pane.document else { return nil }
        let rect = pdfView.convert(page.bounds(for: .cropBox), from: page)
        var key = BoardTextSelectionSnapshotKey(sessionID: pane.id, boardID: pane.id,
            size: pdfView.bounds.size, offset: CGPoint(x: -rect.minX, y: -rect.minY), zoom: pdfView.scaleFactor,
            documentRevision: pane.revision, updatedAt: Date(timeIntervalSinceReferenceDate: 0),
            previewEpoch: document.index(for: page), imageRevision: 0, renderedRevision: paintedRevision)
        key.prefersHighResolution = page === explicitOCRPage
        return key
    }
    private var textSelectionGestureActive: Bool {
        // isTracking becomes true for a stationary finger too. That is useful
        // for save/snapshot exclusion, but would reject Live Text's long press.
        func moving(_ view: UIView) -> Bool {
            if let scroll = view as? UIScrollView, scroll.isDragging || scroll.isDecelerating || scroll.isZooming { return true }
            return view.subviews.contains(where: moving)
        }
        return nativeInkActive || trace.state == .began || trace.state == .changed
            || readingPinch.state == .began || readingPinch.state == .changed || moving(pdfView)
    }
    private func synchronizeTextSelection() {
        guard inlineTextSelection != nil else { return }
        if analysisPage !== pdfView.currentPage {
            explicitOCRPage = nil
            analysisPage = pdfView.currentPage
            analysisPageHasText = !(analysisPage?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        inlineTextSelection.update(textSelectionKey)
        synchronizeSelectionNavigation()
    }
    private func captureTextSelection(_ key: BoardTextSelectionSnapshotKey) -> UIImage? {
        guard textSelectionKey == key, !pane.interactionActive, !inlineTextSelection.hasSelection,
              let page = analysisPage, key.isValid else { return nil }
        let frame = pdfView.convert(page.bounds(for: .cropBox), from: page)
        let number = (pdfView.document?.index(for: page) ?? -1) + 1
        return InlinePDFTextCapture.image(page: page, pageFrame: frame, viewport: pdfView.bounds, scale: key.renderScale) { context, box in
            for mark in self.marks[number] ?? [] {
                PDFWorkspacePaintView.drawAnnotation(mark, in: box, context: context, future: self.futureIDs.contains(mark.id))
            }
        }
    }

    private func synchronizeSelectionNavigation() {
        guard !tornDown else { return }
        if inlineTextSelection?.hasSelection == true {
            func visit(_ view: UIView) {
                if let scroll = view as? UIScrollView,
                   !selectionScrollViews.contains(where: { $0.0 === scroll }) {
                    selectionScrollViews.append((scroll, scroll.panGestureRecognizer.minimumNumberOfTouches))
                    scroll.panGestureRecognizer.minimumNumberOfTouches = 2
                }
                view.subviews.forEach(visit)
            }
            visit(pdfView)
        } else {
            for (scroll, minimum) in selectionScrollViews { scroll.panGestureRecognizer.minimumNumberOfTouches = minimum }
            selectionScrollViews.removeAll()
        }
    }
    func revealVisibleText() {
        synchronizeTextSelection()
        // Native text remains the default. An explicit request also recognizes
        // raster figures/text embedded in an otherwise selectable PDF page.
        explicitOCRPage = pdfView.currentPage
        if !inlineTextSelection.hasSelection { pdfView.clearSelection() }
        synchronizeTextSelection()
        if textSelectionKey != nil {
            pane.textSelectionStatus = inlineTextSelection.revealText().replacingOccurrences(of: "白板", with: "页面")
        }
    }
    @objc private func nativeTextSelectionChanged() {
        guard !tornDown, !inlineTextSelection.hasSelection else { return }
        pane.textSelectionStatus = !(pdfView.currentSelection?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? String(localized: "已选中页面原文，可使用系统菜单或“复制所选”。")
            : String(localized: "长按页面文字可选择并复制。")
    }
    var hasActiveTextSelection: Bool {
        inlineTextSelection.hasSelection || !(pdfView.currentSelection?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    func copyVisibleText() {
        let copied: Bool
        if inlineTextSelection.hasSelection { copied = inlineTextSelection.copySelection() }
        else if let text = pdfView.currentSelection?.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            UIPasteboard.general.string = String(text.unicodeScalars.prefix(200_000)); copied = true
        } else { copied = false }
        pane.textSelectionStatus = copied
            ? String(localized: "已复制所选文字。") : String(localized: "请先长按页面文字并调整选区。")
    }
    // PDFKit installs each overlay inside its own page view. Scrolling and
    // zooming now move the original page and its marks in the same transaction;
    // the display link only tracks reading state, never annotation geometry.
    func pdfView(_ view: PDFView, overlayViewFor page: PDFPage) -> UIView? {
        let key = ObjectIdentifier(page)
        if let existing = pagePaints[key] { return existing }
        let paint = PDFWorkspacePaintView()
        paint.inkHost=self
        paint.pdfView = view; paint.page = page
        paint.backgroundColor = .clear; paint.isOpaque = false
        paint.isUserInteractionEnabled = false
        paint.contentMode = .redraw
        pagePaints[key] = paint
        configure(paint)
        return paint
    }
    func pdfView(_ pdfView: PDFView, willEndDisplayingOverlayView overlayView: UIView, for page: PDFPage) {
        let key = ObjectIdentifier(page)
        if pagePaints[key] === overlayView { pagePaints.removeValue(forKey: key) }
    }
    private func configure(_ paint: PDFWorkspacePaintView) {
        guard let page = paint.page, let document = pdfView.document else { return }
        let number = document.index(for: page) + 1
        paint.marks = marks[number] ?? []
        paint.acknowledgeSavedInk()
        paint.draft = draft?.page == number ? draft : nil
        paint.futureIDs = futureIDs
        paint.readAloudRect = pane.readAloudPage == number - 1 ? pane.readAloudRect : nil
        configureNativeInput(paint)
        paint.setNeedsDisplay()
    }
    private func configureNativeInput(_ paint:PDFWorkspacePaintView) {
        guard let page=paint.page else{return}
        let size=page.bounds(for:.cropBox).applying(page.transform(for:.cropBox)).standardized.size
        let enabled = !tornDown && loaded === pane.document && pane.tool == .ink && pane.canAnnotate
            && !pane.layerReplayActive && !pane.extensionMode && !pane.imageExcerptActive
            && !pane.temporaryTranslation.capture.isSelecting
            && (paint.inkActive || !pane.interactionActive)
            && trace.state != .began && trace.state != .changed
            && readingPinch.state != .began && readingPinch.state != .changed
        paint.configureInk(enabled:enabled,tool:pane.inkTool(width:size.width))
    }
    func nativeInkBegan(_ paint:PDFWorkspacePaintView) -> (source:String,layer:UUID,page:Int)? {
        guard !tornDown,pane.tool == .ink,pane.canAnnotate,let page=paint.page,
              let document=pdfView.document,document === pane.document,let layer=pane.selectedLayerID else{return nil}
        explicitOCRPage=nil;inlineTextSelection.update(nil);pdfView.clearSelection()
        pane.interactionActive=true
        return (pane.sourceSHA256,layer,document.index(for:page)+1)
    }
    func nativeInkEnded(_ paint:PDFWorkspacePaintView,drawing:PKDrawing,width:CGFloat,
                        session:(source:String,layer:UUID,page:Int)?) {
        pane.interactionActive=false
        guard !tornDown,let session,session.source==pane.sourceSHA256,session.layer==pane.selectedLayerID,
              let page=paint.page,let document=pdfView.document,document === pane.document,
              document.index(for:page)+1==session.page,width>0 else{return}
        let aspect=page.bounds(for:.cropBox).applying(page.transform(for:.cropBox)).standardized.height/width
        guard let native=PDFNativeInk.archive(drawing,referenceWidth:width),drawing.strokes.count==1,
              let stroke=drawing.strokes.first,stroke.path.count<=4096 else {
            pane.error=String(localized:"这段笔迹过大，暂未保存。请撤销或分成较短的笔画后重试。");return
        }
        let points=stroke.path.map { p -> [Double] in
            let location=p.location.applying(stroke.transform)
            return [min(1,max(0,location.x/width)),min(1,max(0,location.y/(width*aspect)))]
        }
        guard !points.isEmpty else{return}
        let xs=points.map{$0[0]},ys=points.map{$0[1]}
        let x=min(0.9999,xs.min()!),y=min(0.9999,ys.min()!)
        var red:CGFloat=0,green:CGFloat=0,blue:CGFloat=0,alpha:CGFloat=0
        stroke.ink.color.getRed(&red,green:&green,blue:&blue,alpha:&alpha)
        let color=String(format:"#%02X%02X%02X",Int(min(1,max(0,red))*255),Int(min(1,max(0,green))*255),Int(min(1,max(0,blue))*255))
        let mark=PDFWorkspaceAnnotation(id:UUID(),layerID:session.layer,sourceSHA256:session.source,page:session.page,
            kind:.ink,color:color,width:min(0.05,max(0.0001,(stroke.path.first?.size.width ?? 2)/width)),points:points,
            rect:PDFWorkspaceRect(x:x,y:y,width:min(1-x,max(0.0001,xs.max()!-x)),height:min(1-y,max(0.0001,ys.max()!-y))),text:"",nativeInk:native)
        paint.markPendingInk(native)
        Task { [weak self,weak paint] in
            guard let self,let paint,!self.tornDown,self.pane.sourceSHA256==session.source else{return}
            if await self.pane.addAnnotation(mark) {paint.clearCommittedInk(drawing)}
            self.synchronize()
            self.synchronizeTextSelection()
        }
    }
    private func refreshPagePaints() { pagePaints.values.forEach(configure) }
    @objc private func traceChanged(_ gesture: PDFWorkspaceTraceGesture) {
        switch gesture.state {
        case .began:
            guard pane.canAnnotate, !pane.temporaryTranslation.capture.isSelecting && !pane.imageExcerptActive,
                  let page = pdfView.page(for: gesture.position, nearest: false), let document = pdfView.document,
                  let point = normalized(gesture.position, page: page, clamp: false) else { gesture.isEnabled = false; gesture.isEnabled = true; return }
            explicitOCRPage = nil
            pane.interactionActive = true; strokePage = page; points = [point]; draftTool = pane.tool
            synchronizeTextSelection()
            sourceAtStart = pane.sourceSHA256; layerAtStart = pane.selectedLayerID; sourcePageAtStart = document.index(for: page)+1
            updateDraft()
        case .changed:
            guard let page = strokePage, let point = normalized(gesture.position, page: page, clamp: true) else { return }
            if points.count < 4096 { points.append(point) }; updateDraft()
        case .ended:
            guard let page = strokePage, let point = normalized(gesture.position, page: page, clamp: true) else { cancelDraft(); return }
            if points.count < 4096 { points.append(point) }
            let mark = makeDraft(); cancelDraft()
            guard sourceAtStart == pane.sourceSHA256, layerAtStart == pane.selectedLayerID, let mark else { return }
            if mark.kind == .text { pane.textDraft = mark; pane.draftText = "" }
            else { Task {
                if await pane.addAnnotation(mark), pane.access == .readingHighlights { pane.chooseTool(.read) }
            } }
        case .cancelled, .failed: cancelDraft()
        default: break
        }
    }
    private func normalized(_ point: CGPoint, page: PDFPage, clamp: Bool) -> [Double]? {
        let rect = pdfView.convert(page.bounds(for: .cropBox), from: page)
        guard rect.width > 0, rect.height > 0, clamp || rect.contains(point) else { return nil }
        return [min(1,max(0,Double((point.x-rect.minX)/rect.width))),min(1,max(0,Double((point.y-rect.minY)/rect.height)))]
    }
    private func makeDraft() -> PDFWorkspaceAnnotation? {
        guard let layerAtStart, let first = points.first, let last = points.last else { return nil }
        let kind: PDFWorkspaceAnnotation.Kind = draftTool == .ink ? .ink : draftTool == .highlight ? .highlight : .text
        let xs = kind == .ink ? points.map { $0[0] } : [first[0],last[0]], ys = kind == .ink ? points.map { $0[1] } : [first[1],last[1]]
        let x = min(0.9999,xs.min() ?? 0), y = min(0.9999,ys.min() ?? 0)
        var width = max(0.0001,(xs.max() ?? x)-x), height = max(0.0001,(ys.max() ?? y)-y)
        if kind == .text { width = max(width,0.25); height = max(height,0.07) }
        width = min(width,1-x); height = min(height,1-y)
        return PDFWorkspaceAnnotation(id: UUID(), layerID: layerAtStart, sourceSHA256: sourceAtStart, page: sourcePageAtStart, kind: kind, color: pane.color, width: pane.lineWidth, points: kind == .ink ? points : [], rect: PDFWorkspaceRect(x:x,y:y,width:width,height:height), text: "")
    }
    private func updateDraft() { draft = makeDraft(); refreshPagePaints() }
    private func cancelDraft() { points = []; strokePage = nil; draft = nil; refreshPagePaints(); pane.interactionActive = false }
    func pdfViewWillClick(onLink sender: PDFView, with url: URL) {
        guard ["https", "http", "mailto", "obsidian", "inkspace"].contains(url.scheme?.lowercased() ?? "") else { return }
        if let onOpenURL { onOpenURL(url) } else { UIApplication.shared.open(url) }
    }
    func tearDown() {
        NotificationCenter.default.removeObserver(self)
        inlineTextSelection.tearDown()
        for (scroll, minimum) in selectionScrollViews { scroll.panGestureRecognizer.minimumNumberOfTouches = minimum }
        selectionScrollViews.removeAll()
        if pane.textSelectionHost === self { pane.textSelectionHost = nil }
        tornDown=true
        pdfView.delegate = nil; pdfView.pageOverlayViewProvider = nil; pagePaints.removeAll(); onOpenURL = nil
        displayLink?.invalidate(); displayLink = nil; pulseTarget = nil
        if let readingPinch { removeGestureRecognizer(readingPinch) }; pinchPage = nil
        for (pinch,enabled) in originalPinches { pinch.isEnabled = enabled }; originalPinches = []
        if let trace { pdfView.removeGestureRecognizer(trace) }; cancelDraft()
        if pane.pdfView === pdfView { pane.pdfView = nil; pane.captureSource.view = nil }
    }
    deinit { displayLink?.invalidate() }
}
@MainActor private final class PDFWorkspacePulseTarget: NSObject {
    weak var host: PDFWorkspaceReaderHost?
    @objc func tick() { host?.tick() }
}

@MainActor final class PDFWorkspacePaintView: UIView,PKCanvasViewDelegate {
    weak var pdfView: PDFView?
    weak var page: PDFPage?
    var marks: [PDFWorkspaceAnnotation] = []
    var draft: PDFWorkspaceAnnotation?
    var futureIDs: Set<UUID> = []
    var readAloudRect: CGRect?
    weak var inkHost:PDFWorkspaceReaderHost?
    private let inkCanvas=PKCanvasView()
    private var inkSession:(source:String,layer:UUID,page:Int)?
    private var pendingNativeInk:PDFNativeInkArchive?
    private var permitsInk=false
    private(set) var inkActive=false
    override init(frame:CGRect) {
        super.init(frame:frame)
        inkCanvas.backgroundColor = .clear;inkCanvas.isOpaque=false;inkCanvas.isScrollEnabled=false
        inkCanvas.drawingPolicy = .pencilOnly;inkCanvas.delegate=self;inkCanvas.overrideUserInterfaceStyle = .light
        inkCanvas.panGestureRecognizer.isEnabled=false
        addSubview(inkCanvas)
    }
    required init?(coder:NSCoder){fatalError()}
    func configureInk(enabled:Bool,tool:PKInkingTool) {
        permitsInk=enabled
        guard !inkActive,pendingNativeInk==nil else{return}
        isUserInteractionEnabled=enabled;inkCanvas.isDrawingEnabled=enabled
        if inkCanvas.tool as? PKInkingTool != tool {inkCanvas.tool=tool}
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard !inkActive,let pdfView,let page else{return}
        let displayed=pdfView.convert(page.bounds(for:.cropBox),from:page)
        let size=page.bounds(for:.cropBox).applying(page.transform(for:.cropBox)).standardized.size
        guard size.width>0,size.height>0 else{return}
        let topLeft=convert(CGPoint(x:displayed.minX,y:displayed.minY),from:pdfView)
        let topRight=convert(CGPoint(x:displayed.maxX,y:displayed.minY),from:pdfView)
        let bottomLeft=convert(CGPoint(x:displayed.minX,y:displayed.maxY),from:pdfView)
        inkCanvas.bounds=CGRect(origin:.zero,size:size);inkCanvas.contentSize=size
        inkCanvas.layer.anchorPoint = .zero;inkCanvas.layer.position = .zero
        inkCanvas.transform=PDFWorkspaceOverlayGeometry.transform(size:size,topLeft:topLeft,topRight:topRight,bottomLeft:bottomLeft)
    }
    func canvasViewDidBeginUsingTool(_ canvasView:PKCanvasView) {
        inkSession=inkHost?.nativeInkBegan(self);inkActive=inkSession != nil
    }
    func canvasViewDidEndUsingTool(_ canvasView:PKCanvasView) {
        inkActive=false
        inkHost?.nativeInkEnded(self,drawing:canvasView.drawing,width:canvasView.bounds.width,session:inkSession)
        inkSession=nil
    }
    func clearCommittedInk(_ expected:PKDrawing) {
        guard !inkActive,BoardHeldLineStroke.hasSameStrokes(inkCanvas.drawing,expected) else{return}
        inkCanvas.drawing=PKDrawing()
        pendingNativeInk=nil
        inkCanvas.isDrawingEnabled=permitsInk;isUserInteractionEnabled=permitsInk
    }
    func markPendingInk(_ archive:PDFNativeInkArchive) {
        pendingNativeInk=archive;inkCanvas.isDrawingEnabled=false
    }
    func acknowledgeSavedInk() {
        guard let pendingNativeInk,!inkActive,marks.contains(where:{$0.nativeInk==pendingNativeInk}) else{return}
        inkCanvas.drawing=PKDrawing();self.pendingNativeInk=nil
    }
    override func draw(_ rect: CGRect) {
        guard let pdfView, let page, let context = UIGraphicsGetCurrentContext() else { return }
        if let readAloudRect {
            let highlight = convert(pdfView.convert(readAloudRect, from: page), from: pdfView)
            context.setFillColor(UIColor.systemYellow.withAlphaComponent(0.38).cgColor)
            context.fill(highlight)
        }
        let displayed = pdfView.convert(page.bounds(for: .cropBox), from: page)
        let size = page.bounds(for: .cropBox).applying(page.transform(for: .cropBox)).standardized.size
        guard displayed.width > 0, displayed.height > 0, size.width > 0, size.height > 0 else { return }
        // Overlay bounds are unrotated while persisted coordinates follow the
        // displayed crop box. Convert three corners to retain rotated/cropped
        // pages without migrating any existing annotation coordinates.
        let topLeft = convert(CGPoint(x: displayed.minX, y: displayed.minY), from: pdfView)
        let topRight = convert(CGPoint(x: displayed.maxX, y: displayed.minY), from: pdfView)
        let bottomLeft = convert(CGPoint(x: displayed.minX, y: displayed.maxY), from: pdfView)
        let transform = PDFWorkspaceOverlayGeometry.transform(size: size, topLeft: topLeft, topRight: topRight, bottomLeft: bottomLeft)
        context.saveGState(); defer { context.restoreGState() }
        context.concatenate(transform)
        let box = CGRect(origin: .zero, size: size)
        context.clip(to: box)
        var items = marks; if let draft { items.append(draft) }
        for mark in items { Self.drawAnnotation(mark, in: box, context: context, future: futureIDs.contains(mark.id)) }
    }
    static func drawAnnotation(_ mark: PDFWorkspaceAnnotation, in page: CGRect, context: CGContext, future: Bool = false) {
        context.saveGState(); defer { context.restoreGState() }
        if future { context.setAlpha(0.18) }
        let color = Self.color(mark.color), r = mark.rect
        let box = CGRect(x: page.minX+r.x*page.width,y:page.minY+r.y*page.height,width:r.width*page.width,height:r.height*page.height)
        switch mark.kind {
        case .ink:
            if PDFNativeInk.paint(mark.nativeInk,width:page.width,origin:page.origin,context:context) {break}
            let path = UIBezierPath(); path.lineWidth = max(0.5,mark.width*page.width); path.lineCapStyle = .round; path.lineJoinStyle = .round
            for (index,point) in mark.points.enumerated() {
                let location = CGPoint(x: page.minX+point[0]*page.width,y:page.minY+point[1]*page.height)
                if index == 0 { path.move(to: location) } else { path.addLine(to: location) }
            }
            if mark.points.count == 1, let first = mark.points.first { path.addLine(to: CGPoint(x:page.minX+first[0]*page.width+0.01,y:page.minY+first[1]*page.height)) }
            color.setStroke(); path.stroke()
        case .highlight:
            color.withAlphaComponent(0.25).setFill(); context.fill(box)
        case .text:
            color.withAlphaComponent(0.10).setFill(); context.fill(box)
            (mark.text as NSString).draw(with: box.insetBy(dx: 3, dy: 3), options: [.usesLineFragmentOrigin,.truncatesLastVisibleLine], attributes: [.font:UIFont.systemFont(ofSize:max(7,min(30,page.width*0.025))),.foregroundColor:color], context:nil)
        }
    }
    static func color(_ string: String) -> UIColor {
        let value = UInt32(string.dropFirst(), radix:16) ?? 0
        return UIColor(red:CGFloat((value>>16)&255)/255,green:CGFloat((value>>8)&255)/255,blue:CGFloat(value&255)/255,alpha:1)
    }
}
