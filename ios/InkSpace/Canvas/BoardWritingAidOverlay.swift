import UIKit
import PencilKit

/// Explicit auxiliary input. Attach its Pencil observer to the common ancestor,
/// and disable only the host PKCanvasView drawing recognizer while capturesPencil.
/// Finger scrolling/pinching remains owned by the original canvas.
@MainActor final class BoardWritingAidOverlay: UIView, UIGestureRecognizerDelegate {
    struct Context {
        var boardID: UUID
        var token: BoardWritingAidSessionToken
        var canEdit: Bool
        var zoom: CGFloat
        var worldSize: CGSize
        var ink: PKInk
        var width: CGFloat
        var screenToWorld: (CGPoint) -> CGPoint
        var worldToScreen: (CGPoint) -> CGPoint
    }
    var onCommitDrawing: ((PKDrawing, BoardWritingAidSessionToken) -> Bool)?
    var onInputActivity: ((Bool) -> Void)?
    var onCancelDrawingCommit: ((BoardWritingAidSessionToken) -> Void)?
    var lastDrawingCommitError: String?
    private(set) var gestureBegins = 0, gestureEnds = 0, drawingCommitRequests = 0
    private(set) var inputOutcome = "idle"
    private(set) var lastInputPointCount = 0
    private(set) var lastClosureGap: CGFloat = 0
    var onCreateText: ((BoardWritingAidTextSubmission) -> Bool)?
    /// Return true only when the host has accepted the save task. Finish it via
    /// finishTapeSave; the draft remains visible if persistence fails.
    var onTapesChange: ((BoardWritingAidTapeDocument, BoardWritingAidSessionToken) -> Bool)?
    var onDraftChanged: ((UUID, String) -> Void)?
    var onStatus: ((String) -> Void)?
    var onCloseScribble: (() -> Void)?
    private(set) var mode: BoardWritingAidMode = .off
    private(set) var hasUnsavedTape = false
    private(set) var isSavingTape = false
    var capturesPencil: Bool { mode != .off && context?.canEdit == true }
    var scribbleDraft: String { scribble.draftText }
    var unsavedTapeDocument: BoardWritingAidTapeDocument? { pendingTapeDocument }
    var hasTapeContent: Bool {
        !cachedTapes.isEmpty || !(tapeContainer.sublayers?.isEmpty ?? true) || pendingTapeDocument != nil
    }
    private var context: Context?
    private var settings = BoardWritingAidSettings()
    private var tapes: BoardWritingAidTapeDocument?
    private var pendingTapeDocument: BoardWritingAidTapeDocument?
    private var tapeSaveToken: BoardWritingAidSessionToken?
    private struct CachedTape {
        var geometry: BoardWritingAidTapeGeometry
        var layer: CAShapeLayer
    }
    private var cachedTapes: [UUID: CachedTape] = [:]
    private var tapePaintOrder: [UUID] = []
    private var tapeProjection: BoardWritingAidTapeProjection?
    private var acceptsReloadedTapeDocument = false
    private var laserLayers: [CAShapeLayer] = []
    // Tape has its own compositing owner. Clearing the last tape can therefore
    // invalidate the whole mask subtree without touching preview/ink/Scribble.
    private let tapeContainer = CALayer()
    private let preview = CAShapeLayer()
    private let scribble = BoardWritingAidScribbleView()
    private var inputContext: Context?
    private var inputActivity = false
    private var pendingDrawingToken: BoardWritingAidSessionToken?
    private var points: [CGPoint] = []
    private weak var inputHost: UIView?
    private var canReceivePencil: ((UITouch) -> Bool)?
    private lazy var pencilGesture = BoardWritingAidPencilGesture(target: self, action: #selector(pencilChanged(_:)))
    private lazy var revealTap = UITapGestureRecognizer(target: self, action: #selector(toggleTapeAtTap(_:)))

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear; isOpaque = false; clipsToBounds = true
        accessibilityIdentifier = "writingAid.overlay"
        tapeContainer.masksToBounds = true; layer.addSublayer(tapeContainer)
        preview.fillColor = nil; preview.lineCap = .round; preview.lineJoin = .round
        preview.isHidden = true; layer.addSublayer(preview)
        addSubview(scribble)
        scribble.onCreateText = { [weak self] submission in
            guard let self, self.mode == .scribble, self.context?.canEdit == true,
                  self.context?.token == submission.token else { return false }
            return self.onCreateText?(submission) == true
        }
        scribble.onDraftChanged = { [weak self] session, text in self?.onDraftChanged?(session, text) }
        scribble.onClose = { [weak self] in self?.onCloseScribble?() }
        pencilGesture.delegate = self
        pencilGesture.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        pencilGesture.cancelsTouchesInView = true
        pencilGesture.delaysTouchesBegan = false; pencilGesture.delaysTouchesEnded = false
        revealTap.delegate = self
        revealTap.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        revealTap.cancelsTouchesInView = false
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    func attachPencilInput(to host: UIView, canReceive: @escaping (UITouch) -> Bool) {
        guard self !== host, isDescendant(of: host) else { detachPencilInput(); return }
        if inputHost === host { canReceivePencil = canReceive; return }
        detachPencilInput()
        inputHost = host; canReceivePencil = canReceive; pencilGesture.coordinateView = self
        host.addGestureRecognizer(pencilGesture); host.addGestureRecognizer(revealTap)
        synchronizeRecognizers()
    }
    func detachPencilInput() {
        cancelInput()
        pencilGesture.view?.removeGestureRecognizer(pencilGesture)
        revealTap.view?.removeGestureRecognizer(revealTap)
        pencilGesture.coordinateView = nil; inputHost = nil; canReceivePencil = nil
    }

    func update(context next: Context, mode: BoardWritingAidMode,
                settings: BoardWritingAidSettings, tapes incoming: BoardWritingAidTapeDocument?) {
        var next = next
        if !next.zoom.isFinite || next.zoom <= 0 || !next.width.isFinite || next.width <= 0 || next.width > 4096
            || !next.worldSize.width.isFinite || !next.worldSize.height.isFinite
            || next.worldSize.width <= 0 || next.worldSize.height <= 0 { next.canEdit = false }
        let changedSession = context?.boardID != next.boardID || context?.token.sessionID != next.token.sessionID
        let changedToken = context?.token != next.token
        let changedViewport = changedSession || context?.token.viewportRevision != next.token.viewportRevision
        let changedMode = self.mode != mode
        let changedAttributes = context.map { $0.ink.inkType != next.ink.inkType || $0.ink.color != next.ink.color || $0.width != next.width } ?? false
        if (self.mode != .off || mode != .off), (changedToken || changedMode || !next.canEdit || changedAttributes) { cancelInput() }
        if changedSession {
            // The host must flush an accepted tape save before replacing its
            // board. Never send a previous board's draft to a new board callback.
            tapes = nil; pendingTapeDocument = nil; isSavingTape = false; hasUnsavedTape = false; tapeSaveToken = nil
            acceptsReloadedTapeDocument = false
        }
        let changedTapes: Bool
        if !hasUnsavedTape, let incoming, incoming.boardID == next.boardID,
           acceptsReloadedTapeDocument || tapes?.boardID != incoming.boardID || incoming.revision > (tapes?.revision ?? 0),
           (try? incoming.validate()) != nil {
            changedTapes = true; tapes = incoming; acceptsReloadedTapeDocument = false
        } else { changedTapes = changedSession }
        self.context = next; self.mode = mode; self.settings = settings.normalized
        // The normal ink path does no auxiliary layout, recognition, timers,
        // stroke enumeration or redraw. Existing masks move only with viewport.
        if mode == .off, !changedMode, !changedSession {
            if changedTapes || changedViewport { renderTapes(rebuildGeometry: changedTapes) }
            return
        }
        let anchor = next.screenToWorld(CGPoint(x: bounds.midX, y: bounds.midY))
        scribble.configure(boardID: next.boardID, token: next.token, canEdit: next.canEdit, settings: self.settings,
                           color: next.ink.color, worldAnchor: anchor)
        scribble.setActive(mode == .scribble && next.canEdit)
        synchronizeRecognizers()
        if changedTapes || changedViewport || changedMode { renderTapes(rebuildGeometry: changedTapes || changedMode) }
        if changedMode || changedSession { setNeedsLayout() }
    }
    func restoreScribbleDraft(_ text: String, worldAnchor: CGPoint) { scribble.restoreDraft(text, worldAnchor: worldAnchor) }

    func finishTapeSave(committed: BoardWritingAidTapeDocument?, token: BoardWritingAidSessionToken,
                        expectedDraft: BoardWritingAidTapeDocument, error: String? = nil) {
        guard let pending = pendingTapeDocument, tapeSaveToken == token,
              expectedDraft == pending,
              context?.boardID == committed?.boardID || committed == nil,
              context?.token.sessionID == token.sessionID else { return }
        if let committed, (try? committed.validate()) != nil {
            guard pending.revision < UInt64.max, committed.revision == pending.revision + 1 else { return }
            var original = committed; original.revision = pending.revision
            guard original == pending else { return }
            isSavingTape = false
            tapes = committed; pendingTapeDocument = nil; hasUnsavedTape = false; tapeSaveToken = nil
            renderTapes(); onStatus?(String(localized: "胶带已保存；轻点胶带可揭开或重新遮挡。"))
        } else {
            isSavingTape = false
            hasUnsavedTape = true
            onStatus?(error ?? String(localized: "胶带未能保存，遮挡草稿已保留，请重试。"))
        }
    }
    /// Settings-side delete/reveal commits do not own the canvas's Pencil-save
    /// token. Accept their successful persisted state independently, while a
    /// delayed acknowledgement must never erase a newer local draft.
    func synchronizeCommittedTapes(_ committed: BoardWritingAidTapeDocument, sessionID: UUID) {
        guard context?.boardID == committed.boardID, context?.token.sessionID == sessionID,
              (try? committed.validate()) != nil,
              tapes?.boardID != committed.boardID || committed.revision >= (tapes?.revision ?? 0) else { return }
        guard pendingTapeDocument == nil else { return }
        tapes = committed; pendingTapeDocument = nil; hasUnsavedTape = false
        isSavingTape = false; tapeSaveToken = nil
        acceptsReloadedTapeDocument = false
        renderTapes()
    }
    func retryTapeSave() {
        guard let draft = pendingTapeDocument else { return }
        requestTapeSave(draft)
    }
    func discardUnsavedTape() {
        guard !isSavingTape else { return }
        pendingTapeDocument = nil; hasUnsavedTape = false; tapeSaveToken = nil
        // Explicit reload may legitimately return revision zero (a deleted
        // remote sidecar) or the same revision. Keep the last committed image
        // while loading, then allow that one validated replacement to win.
        acceptsReloadedTapeDocument = true
        renderTapes()
    }
    func toggleTape(_ id: UUID) {
        guard mode == .tape, let context, context.canEdit, !isSavingTape, !hasUnsavedTape,
              let tapes, let next = try? tapes.toggling(id) else { return }
        requestTapeSave(next)
    }

    func cancelInput() {
        if let token = pendingDrawingToken { pendingDrawingToken = nil; onCancelDrawingCommit?(token) }
        setInputActivity(false)
        inputContext = nil; points = []; preview.isHidden = true
        preview.removeAllAnimations(); preview.path = nil
        laserLayers.forEach { $0.removeAllAnimations(); $0.removeFromSuperlayer() }; laserLayers = []
        scribble.cancelPendingSubmission()
        pencilGesture.isEnabled = false
        pencilGesture.isEnabled = capturesPencil && mode != .scribble
    }
    func finishDrawingCommit(token: BoardWritingAidSessionToken, error: String?) {
        guard pendingDrawingToken == token else { return }
        pendingDrawingToken = nil; preview.isHidden = true; preview.path = nil
        inputOutcome = error == nil ? "committed" : "commitRejected"
        if let error { onStatus?(error) }
    }
    private func setInputActivity(_ active: Bool) {
        guard inputActivity != active else { return }
        inputActivity = active; onInputActivity?(active)
    }
    override func didMoveToWindow() { super.didMoveToWindow(); if window == nil { cancelInput(); scribble.setActive(false) } }
    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        tapeContainer.frame = bounds; tapeContainer.bounds = bounds
        CATransaction.commit()
        let width = min(420, max(0, bounds.width - 24)), height = min(260, max(0, bounds.height - 24))
        scribble.frame = CGRect(x: bounds.midX - width / 2, y: max(12, bounds.maxY - height - 16), width: width, height: height)
        projectTapeLayers()
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, isUserInteractionEnabled, alpha > 0.01 else { return nil }
        if !scribble.isHidden, scribble.frame.contains(point) { return scribble.hitTest(convert(point, to: scribble), with: event) }
        // A sibling canvas receives ordinary finger gestures, even under masks.
        return nil
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let context, context.canEdit, window != nil else { return false }
        if let view = touch.view, view === scribble || view.isDescendant(of: scribble) { return false }
        if gestureRecognizer === pencilGesture {
            return capturesPencil && mode != .scribble && touch.type == .pencil && pendingDrawingToken == nil
                && canReceivePencil?(touch) == true && (!isSavingTape && !hasUnsavedTape || mode != .tape)
        }
        if gestureRecognizer === revealTap {
            var candidate = touch.view
            while let view = candidate, view !== inputHost {
                if view is UIControl { return false }
                candidate = view.superview
            }
            return mode == .tape && !isSavingTape && !hasUnsavedTape && hitTape(at: touch.location(in: self)) != nil
        }
        return false
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        false
    }
    private func synchronizeRecognizers() {
        let pencilEnabled = capturesPencil && mode != .scribble
        let tapEnabled = mode == .tape && context?.canEdit == true
        if pencilGesture.isEnabled != pencilEnabled { pencilGesture.isEnabled = pencilEnabled }
        if revealTap.isEnabled != tapEnabled { revealTap.isEnabled = tapEnabled }
    }

    @objc private func pencilChanged(_ gesture: BoardWritingAidPencilGesture) {
        switch gesture.state {
        case .began:
            guard let context, context.canEdit, mode != .off, mode != .scribble, pendingDrawingToken == nil else { return }
            gestureBegins += 1; inputOutcome = "collecting"
            inputContext = context; points = gesture.points
            setInputActivity(true)
            preview.isHidden = false; updatePreview()
        case .changed:
            guard inputIsCurrent else { cancelInput(); return }
            points = gesture.points; updatePreview()
        case .ended:
            guard inputIsCurrent, let context = inputContext else { cancelInput(); return }
            gestureEnds += 1; inputOutcome = "ended"
            points = gesture.points
            lastInputPointCount = points.count
            if let a=points.first,let b=points.last { lastClosureGap=hypot(a.x-b.x,a.y-b.y) }
            defer {
                inputContext = nil; points = []; setInputActivity(false)
                if pendingDrawingToken == nil { preview.isHidden = true; preview.path = nil }
            }
            do {
                let world = points.map(context.screenToWorld)
                switch mode {
                case .laser: finishLaser()
                case .wavy:
                    let drawing = try BoardWritingAidStrokes.wavy(points: world, ink: context.ink, width: context.width,
                        wavelength: max(18, context.width * context.zoom * 5) / context.zoom,
                        amplitude: max(3, context.width * context.zoom * 1.5) / context.zoom, worldSize: context.worldSize)
                    guard requestDrawingCommit(drawing, token: context.token) else { return }
                case .fill:
                    let drawing = try BoardWritingAidStrokes.fill(points: world, color: context.ink,
                        closureTolerance: 22 / context.zoom, worldSize: context.worldSize, autoClose: true)
                    guard requestDrawingCommit(drawing, token: context.token) else { return }
                case .tape:
                    if points.count <= 2, let point = points.first, let id = hitTape(at: point) { toggleTape(id); return }
                    guard var document = tapes, document.boardID == context.boardID else { throw BoardWritingAidFailure.unavailable }
                    let color = context.ink.color.resolvedColor(with: traitCollection)
                    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
                    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { throw BoardWritingAidFailure.invalidGeometry }
                    let tape = BoardWritingAidTape(points: world.map(BoardWritingAidPoint.init),
                        width: max(18 / context.zoom, context.width * 6),
                        color: BoardWritingAidColor(red: red, green: green, blue: blue, alpha: 1))
                    try tape.validate(worldSize: context.worldSize)
                    document.tapes.append(tape); try document.validate(); requestTapeSave(document)
                case .off, .scribble: break
                }
            } catch { inputOutcome = "geometryRejected"; onStatus?(error.localizedDescription) }
        case .cancelled, .failed: inputOutcome = "inputCancelled"; cancelInput()
        default: break
        }
    }
    private func requestDrawingCommit(_ drawing: PKDrawing, token: BoardWritingAidSessionToken) -> Bool {
        drawingCommitRequests += 1; lastDrawingCommitError = nil
        guard onCommitDrawing?(drawing, token) == true else {
            inputOutcome = "commitRejected"
            onStatus?(lastDrawingCommitError ?? BoardWritingAidFailure.changedSession.localizedDescription)
            return false
        }
        pendingDrawingToken = token; inputOutcome = "queued"
        return true
    }
    private var inputIsCurrent: Bool {
        guard let inputContext, let context else { return false }
        return context.canEdit && inputContext.token == context.token && inputContext.boardID == context.boardID
            && context.zoom.isFinite && context.zoom > 0
    }
    private func updatePreview() {
        guard let context = inputContext, !points.isEmpty else { return }
        let path = UIBezierPath(); path.move(to: points[0]); points.dropFirst().forEach { path.addLine(to: $0) }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        preview.fillColor = nil; preview.strokeColor = context.ink.color.cgColor
        preview.lineWidth = max(1, context.width * context.zoom)
        if mode == .laser { preview.strokeColor = UIColor.systemRed.cgColor; preview.lineWidth = 3; preview.shadowColor = UIColor.systemRed.cgColor; preview.shadowOpacity = 0.7; preview.shadowRadius = 4 }
        else { preview.shadowOpacity = 0 }
        if mode == .tape { preview.lineWidth = max(18, context.width * context.zoom * 6) }
        if mode == .fill { path.close(); preview.fillColor = context.ink.color.withAlphaComponent(0.2).cgColor }
        if mode == .wavy,
           let drawing = try? BoardWritingAidStrokes.wavy(points: points.map(context.screenToWorld), ink: context.ink,
               width: context.width, wavelength: max(18, context.width * context.zoom * 5) / context.zoom,
               amplitude: max(3, context.width * context.zoom * 1.5) / context.zoom, worldSize: context.worldSize),
           let stroke = drawing.strokes.first, let first = stroke.path.first {
            let wave = UIBezierPath(); wave.move(to: context.worldToScreen(first.location))
            stroke.path.dropFirst().forEach { wave.addLine(to: context.worldToScreen($0.location)) }
            preview.path = wave.cgPath
        } else { preview.path = path.cgPath }
        preview.isHidden = false; CATransaction.commit()
    }
    private func finishLaser() {
        guard let path = preview.path else { return }
        let laser = CAShapeLayer(); laser.path = path; laser.strokeColor = UIColor.systemRed.cgColor
        laser.fillColor = nil; laser.lineWidth = 3; laser.lineCap = .round; laser.lineJoin = .round
        laser.shadowColor = UIColor.systemRed.cgColor; laser.shadowOpacity = 0.7; laser.shadowRadius = 4
        layer.addSublayer(laser); laserLayers.append(laser)
        while laserLayers.count > 12 { laserLayers.removeFirst().removeFromSuperlayer() }
        let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 1; fade.toValue = 0
        fade.duration = settings.laserFadeDuration; laser.opacity = 0; laser.add(fade, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + settings.laserFadeDuration) { [weak self, weak laser] in
            laser?.removeFromSuperlayer(); self?.laserLayers.removeAll { $0 === laser }
        }
    }
    private func requestTapeSave(_ document: BoardWritingAidTapeDocument) {
        guard let context, context.canEdit, mode == .tape, !isSavingTape,
              document.boardID == context.boardID, (try? document.validate()) != nil else { return }
        pendingTapeDocument = document; hasUnsavedTape = true; tapeSaveToken = context.token; isSavingTape = true
        renderTapes()
        guard onTapesChange?(document, context.token) == true else {
            isSavingTape = false; onStatus?(String(localized: "胶带尚未保存，草稿已保留，请重试。")); return
        }
    }
    @objc private func toggleTapeAtTap(_ gesture: UITapGestureRecognizer) {
        if gesture.state == .ended, let id = hitTape(at: gesture.location(in: self)) { toggleTape(id) }
    }
    /// Geometry is rebuilt only on an accepted document/draft change. A camera
    /// update never iterates the tape's points or constructs a CGPath.
    private func renderTapes(rebuildGeometry: Bool = true) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        if rebuildGeometry {
            let source = (pendingTapeDocument ?? tapes)?.tapes ?? []
            let ids = Set(source.map(\.id))
            for id in Set(cachedTapes.keys).subtracting(ids) {
                if let removed = cachedTapes.removeValue(forKey: id)?.layer { removeTapeLayer(removed) }
            }
            tapePaintOrder = []
            for tape in source {
                let key = BoardWritingAidTapeGeometry.Key(tape)
                let cached: CachedTape
                if let existing = cachedTapes[tape.id], existing.geometry.key == key {
                    cached = existing
                } else if let geometry = BoardWritingAidTapeGeometry(tape) {
                    let shape = cachedTapes[tape.id]?.layer ?? CAShapeLayer()
                    shape.anchorPoint = .zero; shape.position = .zero
                    shape.bounds = CGRect(origin: .zero, size: geometry.worldBounds.size)
                    shape.contentsScale = max(1, traitCollection.displayScale)
                    shape.path = geometry.path
                    cached = CachedTape(geometry: geometry, layer: shape)
                } else {
                    if let removed = cachedTapes.removeValue(forKey: tape.id)?.layer { removeTapeLayer(removed) }
                    continue
                }
                let shape = cached.layer
                let color = UIColor(red: tape.color.red, green: tape.color.green, blue: tape.color.blue, alpha: tape.color.alpha)
                // Revealed means completely clean original content in every
                // mode. Management stays in the list; geometry remains hittable.
                shape.opacity = tape.isRevealed ? 0 : 1
                shape.fillColor = tape.isRevealed ? UIColor.clear.cgColor : color.cgColor
                shape.strokeColor = nil
                shape.lineDashPattern = nil
                cachedTapes[tape.id] = cached; tapePaintOrder.append(tape.id)
                // Reusing a layer must still follow document order after edits.
                tapeContainer.addSublayer(shape)
            }
            let retained = Set(cachedTapes.values.map { ObjectIdentifier($0.layer) })
            for shape in tapeContainer.sublayers ?? [] where !retained.contains(ObjectIdentifier(shape)) {
                removeTapeLayer(shape)
            }
            if cachedTapes.isEmpty {
                tapeContainer.sublayers = nil
                tapePaintOrder = []
                tapeContainer.setNeedsDisplay()
                layer.setNeedsDisplay()
            }
            tapeProjection = nil
        }
        projectTapeLayers()
    }

    private func removeTapeLayer(_ value: CALayer) {
        value.removeAllAnimations(); value.isHidden = true
        if let shape = value as? CAShapeLayer {
            shape.path = nil; shape.fillColor = nil; shape.strokeColor = nil; shape.lineDashPattern = nil
        }
        value.removeFromSuperlayer()
    }

    private func projectTapeLayers() {
        guard !cachedTapes.isEmpty else { tapeProjection = nil; return }
        guard let context,
              let next = BoardWritingAidTapeProjection(zoom: context.zoom,
                  screenOrigin: context.worldToScreen(.zero), bounds: bounds) else {
            cachedTapes.values.forEach { $0.layer.isHidden = true }
            tapeProjection = nil
            return
        }
        guard tapeProjection != next else { return }
        tapeProjection = next
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        for id in tapePaintOrder {
            guard let cached = cachedTapes[id] else { continue }
            let shape = cached.layer
            let visible = cached.geometry.worldBounds.intersects(next.visibleWorldRect)
            shape.isHidden = !visible
            guard visible else { continue }
            let transform = next.transform(worldOrigin: cached.geometry.origin)
            guard [transform.a, transform.d, transform.tx, transform.ty].allSatisfy(\.isFinite) else { shape.isHidden = true; continue }
            shape.setAffineTransform(transform)
            shape.lineWidth = 1.5 / next.zoom
            if shape.strokeColor != nil { shape.lineDashPattern = [NSNumber(value: Double(5 / next.zoom)), NSNumber(value: Double(4 / next.zoom))] }
        }
    }

    private func hitTape(at point: CGPoint) -> UUID? {
        guard let context else { return nil }
        let world = context.screenToWorld(point)
        guard world.x.isFinite, world.y.isFinite else { return nil }
        return tapePaintOrder.reversed().first { id in
            cachedTapes[id]?.geometry.contains(worldPoint: world) == true
        }
    }

}

/// Receives only real Pencil touches through the host predicate. No synthetic
/// touch forwarding, OCR, timers or drawing work occurs for ordinary ink input.
@MainActor private final class BoardWritingAidPencilGesture: UIGestureRecognizer {
    weak var coordinateView: UIView?
    private(set) var points: [CGPoint] = []
    private weak var pencil: UITouch?
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard pencil == nil, touches.count == 1, let touch = touches.first, touch.type == .pencil,
              coordinateView != nil else { state = .failed; return }
        pencil = touch; points = [touch.location(in: coordinateView)]; state = .began
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let pencil, touches.contains(pencil) else { return }
        for touch in event.coalescedTouches(for: pencil) ?? [pencil] { append(touch.location(in: coordinateView)) }
        if state != .failed { state = .changed }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let pencil, touches.contains(pencil) else { return }
        append(pencil.location(in: coordinateView))
        if state != .failed { state = .ended }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .cancelled }
    override func reset() { super.reset(); points = []; pencil = nil }
    private func append(_ point: CGPoint) {
        guard point.x.isFinite, point.y.isFinite else { state = .failed; return }
        if let last = points.last, hypot(point.x - last.x, point.y - last.y) < 0.7 { return }
        guard points.count < BoardWritingAidStrokes.maximumInputPoints else { state = .failed; return }
        points.append(point)
    }
}


// MARK: - Camera-independent tape geometry

/// World-unit geometry with a local origin keeps eight-million-point board
/// coordinates out of Core Animation's float transforms. One immutable path is
/// shared by the layer and hit testing; no second projected copy is allocated.
private struct BoardWritingAidTapeGeometry {
    struct Key: Equatable {
        var points: [BoardWritingAidPoint]
        var width: Double
        var anchorItemID: UUID?
        init(_ tape: BoardWritingAidTape) {
            points = tape.points; width = tape.width; anchorItemID = tape.anchorItemID
        }
    }
    let key: Key
    let path: CGPath
    let origin: CGPoint
    let worldBounds: CGRect

    init?(_ tape: BoardWritingAidTape) {
        guard tape.anchorItemID == nil, let first = tape.points.first,
              (try? tape.validate()) != nil else { return nil }
        key = Key(tape)
        let sourceOrigin = first.cgPoint
        let centerline = CGMutablePath(); centerline.move(to: .zero)
        if tape.points.count == 1 { centerline.addLine(to: CGPoint(x: 0.01, y: 0)) }
        else {
            for point in tape.points.dropFirst() {
                centerline.addLine(to: CGPoint(x: point.x - first.x, y: point.y - first.y))
            }
        }
        let band = centerline.copy(strokingWithWidth: tape.width, lineCap: .round, lineJoin: .round, miterLimit: 1)
        let bandBounds = band.boundingBoxOfPath
        origin = CGPoint(x: sourceOrigin.x + bandBounds.minX, y: sourceOrigin.y + bandBounds.minY)
        var translation = CGAffineTransform(translationX: -bandBounds.minX, y: -bandBounds.minY)
        guard let localBand = band.copy(using: &translation) else { return nil }
        path = localBand
        worldBounds = CGRect(origin: origin, size: bandBounds.size)
    }

    func contains(worldPoint: CGPoint) -> Bool {
        worldBounds.contains(worldPoint)
            && path.contains(CGPoint(x: worldPoint.x - origin.x, y: worldPoint.y - origin.y))
    }
}

private struct BoardWritingAidTapeProjection: Equatable {
    let zoom: CGFloat
    let screenOrigin: CGPoint
    let bounds: CGRect
    let visibleWorldRect: CGRect

    init?(zoom: CGFloat, screenOrigin: CGPoint, bounds: CGRect) {
        guard zoom.isFinite, zoom > 0,
              [screenOrigin.x, screenOrigin.y, bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy(\.isFinite),
              bounds.width >= 0, bounds.height >= 0 else { return nil }
        self.zoom = zoom; self.screenOrigin = screenOrigin; self.bounds = bounds
        let topLeft = CGPoint(x: (bounds.minX - screenOrigin.x) / zoom, y: (bounds.minY - screenOrigin.y) / zoom)
        let visible = CGRect(x: topLeft.x, y: topLeft.y, width: bounds.width / zoom, height: bounds.height / zoom)
        guard [visible.minX, visible.minY, visible.width, visible.height].allSatisfy(\.isFinite) else { return nil }
        // Retain the fixed-width revealed border at the screen edge.
        let padding = 2 / zoom
        guard padding.isFinite else { return nil }
        let expanded = visible.insetBy(dx: -padding, dy: -padding)
        guard [expanded.minX, expanded.minY, expanded.width, expanded.height].allSatisfy(\.isFinite) else { return nil }
        visibleWorldRect = expanded
    }

    func transform(worldOrigin: CGPoint) -> CGAffineTransform {
        CGAffineTransform(a: zoom, b: 0, c: 0, d: zoom,
                          tx: worldOrigin.x * zoom + screenOrigin.x,
                          ty: worldOrigin.y * zoom + screenOrigin.y)
    }
}
