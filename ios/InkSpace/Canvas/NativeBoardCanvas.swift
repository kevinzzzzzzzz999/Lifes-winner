import PencilKit
import CryptoKit
import SwiftUI
import UIKit
import os

/// The native ink surface. All geometry is in logical world points; the million-point
/// extent belongs to a scroll view, never to a million-point raster image.
struct NativeBoardCanvas: UIViewRepresentable {
    var store: BoardStore
    var temporaryCapture: TemporaryBoardCapture?
    var onOpenVideo: ((BoardVideoRequest) -> Void)?
    var onEditItem: ((BoardItem) -> Void)?
    var onOpenWeb: ((URL) -> Void)?
    var allowsTextSelection: Bool
    var mergePlacement: BoardMergePlacementSession?
    private let mergePositionInput: CGPoint?
    // Home in its separate window, replay, or a presented sheet owns
    // accessibility focus. Hide only this covered host, restoring its complete
    // PencilKit/Live Text tree when the visible workspace resumes.
    var hidesCanvasAccessibility: Bool
    // Read these while SwiftUI constructs the view, not only inside UIKit's
    // conditional synchronization paths. Reordering must not drop observation of
    // the next independent pen request when the preset comparison short-circuits.
    private let savedPensInput: [SavedPen]
    private let paletteEntriesInput: [NativePaletteEntry]
    private let penRequestInput: SavedPenSelectionRequest?
    private let padReadingInput: Bool
    private let phoneMarkupInput: Bool
    private let phonePenInput: SavedPen
    private let phoneEraserInput: Bool
    private let reviewInput: Bool
    private let reviewsInput: [BoardReview]
    private let reviewCaptureInput: Bool
    private let reviewDraftInput: BoardReview?
    private let reviewColorInput: String
    private let reviewVisibilityInput: Bool
    private let reviewSelectedIDInput: UUID?
    private let reviewStyleInput: BoardReviewStyle
    private let reviewEraserInput: Bool
    private let reviewStrokeWidthInput: Double
    private let modeInput: BoardMode
    private let commandIDInput: UUID?
    private let isBusyInput: Bool
    private let insertionPointInput: CGPoint?
    private let printFramesInput: [BoardPrintFrame]
    private let printSelectionInput: UUID?
    private let printVisibilityInput: Bool
    private let childItemsInput: [BoardItem]
    private let childRevisionInput: Int
    private let webItemsInput: [BoardItem]
    private let writingPriorityInput: Bool
    private let writingAidInput: BoardWritingAidMode
    private let writingAidSettingsInput: BoardWritingAidSettings
    private let writingAidTapesInput: BoardWritingAidTapeDocument?
    private let writingAidCommitInput: UUID?
    private let writingAidReturnInput: UUID?
    private let writingAidReloadInput: UUID?

    init(store: BoardStore, onOpenVideo: ((BoardVideoRequest) -> Void)? = nil, temporaryCapture: TemporaryBoardCapture? = nil, onEditItem: ((BoardItem) -> Void)? = nil, onOpenWeb: ((URL) -> Void)? = nil, allowsTextSelection: Bool = true, mergePlacement: BoardMergePlacementSession? = nil, hidesCanvasAccessibility: Bool = false) {
        self.store = store
        self.temporaryCapture = temporaryCapture
        self.onOpenVideo = onOpenVideo
        self.onEditItem = onEditItem
        self.onOpenWeb = onOpenWeb
        self.mergePlacement = mergePlacement
        mergePositionInput = mergePlacement?.position
        self.allowsTextSelection = allowsTextSelection
        self.hidesCanvasAccessibility = hidesCanvasAccessibility
        savedPensInput = store.savedPens
        paletteEntriesInput = store.nativePaletteEntries
        penRequestInput = store.savedPenSelectionRequest
        padReadingInput = store.isPadReading
        phoneMarkupInput = store.phoneMarkupEnabled
        phonePenInput = store.phonePen
        phoneEraserInput = store.phoneEraserEnabled
        reviewInput = store.reviewModeEnabled
        reviewsInput = store.reviews.records
        reviewCaptureInput = store.reviews.captureEnabled
        reviewDraftInput = store.reviews.draft
        reviewColorInput = store.reviews.color
        reviewVisibilityInput = store.reviews.overlaysVisible
        reviewSelectedIDInput = store.reviews.selectedID
        reviewStyleInput = store.reviews.style
        reviewEraserInput = store.reviews.eraserEnabled
        reviewStrokeWidthInput = store.reviews.strokeWidth
        modeInput = store.mode
        commandIDInput = store.command?.id
        isBusyInput = store.isBusy
        insertionPointInput = store.insertionPoint
        printFramesInput = store.printFrames
        printSelectionInput = store.selectedPrintFrameID
        printVisibilityInput = store.showsPrintFrames
        childItemsInput = store.document.items.filter { !($0.childBoards?.isEmpty ?? true) }
        childRevisionInput = store.childRoot.childSessionRevision
        webItemsInput = store.document.items.filter { $0.kind == .text }
        writingPriorityInput = store.childRoot.writingPriorityEnabled
        writingAidInput = store.writingAids.mode
        writingAidSettingsInput = store.writingAids.settings
        writingAidTapesInput = store.writingAids.tapes
        writingAidCommitInput = store.writingAids.lastTapeCommit?.id
        writingAidReturnInput = store.writingAids.nativeInkRequest
        writingAidReloadInput = store.writingAids.tapeReloadRequest
    }

    func makeUIView(context: Context) -> BoardCanvasHost {
        let host = BoardCanvasHost(store: store)
        host.mergePlacement = mergePlacement
        host.allowsReadingTextSelection = allowsTextSelection
        host.accessibilityElementsHidden = hidesCanvasAccessibility
        host.onOpenVideo = onOpenVideo
        host.onEditItem = onEditItem
        host.onOpenWeb = onOpenWeb
        temporaryCapture?.source = host
        return host
    }

    func updateUIView(_ uiView: BoardCanvasHost, context: Context) {
        uiView.mergePlacement = mergePlacement
        uiView.allowsReadingTextSelection = allowsTextSelection
        if uiView.accessibilityElementsHidden != hidesCanvasAccessibility {
            uiView.accessibilityElementsHidden = hidesCanvasAccessibility
        }
        uiView.onOpenVideo = onOpenVideo
        uiView.onEditItem = onEditItem
        uiView.onOpenWeb = onOpenWeb
        temporaryCapture?.source = uiView
        uiView.synchronize(with: store)
    }

    static func dismantleUIView(_ uiView: BoardCanvasHost, coordinator: Void) {
        uiView.tearDown()
    }
}

/// Diagnostic text is requested by accessibility clients, never assembled in
/// the Pencil event path. Native PencilKit rendering and input stay unchanged.
@MainActor
final class BoardInkCanvasView: PKCanvasView {
    var diagnosticValue: (() -> String?)?
    var undoRedoAllowed: (() -> Bool)?
    // Scoped only around a synchronous app-lasso drawing commit. Never create
    // a manager or ask the host/canvas again from this getter.
    fileprivate var lassoCommitUndoManager: UndoManager?
    override var undoManager: UndoManager? { lassoCommitUndoManager ?? super.undoManager }
    var usesAppOwnedLassoAccessibility = false
    private(set) var appOwnedAccessibilityBypasses = 0
    override var accessibilityElements: [Any]? {
        get {
            // App lasso has its own accessible controls. Parent geometry sorting
            // can request PencilKit's full drawing through its child getter.
            // VoiceOver and Switch Control retain the original native tree,
            // as do all native tool modes.
            if usesAppOwnedLassoAccessibility,
               !UIAccessibility.isVoiceOverRunning, !UIAccessibility.isSwitchControlRunning {
                appOwnedAccessibilityBypasses &+= 1
                return []
            }
            return super.accessibilityElements
        }
        set { super.accessibilityElements = newValue }
    }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        let name = NSStringFromSelector(action)
        if (name == "undo:" || name == "redo:"), undoRedoAllowed?() == false { return false }
        return super.canPerformAction(action, withSender: sender)
    }
    override var accessibilityValue: String? {
        get { diagnosticValue?() ?? super.accessibilityValue }
        set { super.accessibilityValue = newValue }
    }
}

private enum BoardPencilHoldResult {
    case line(BoardPencilLineTracker.Line)
    case shape(BoardPencilShapeTracker.ShapeResult)
    var points: [CGPoint] {
        switch self {
        case .line(let line): [line.start, line.end]
        case .shape(let shape): shape.points
        }
    }
}

/// An observer only: it never recognizes, delays, cancels or prevents native ink.
@MainActor private final class BoardPencilHoldLineGesture: UIGestureRecognizer {
    weak var coordinateView: UIView?
    var canObserve: ((UITouch) -> Bool)?
    var onBegin: ((BoardPencilShapeSettings.Shape) -> Void)?
    var onPreview: ((BoardPencilHoldResult?) -> Void)?
    var onFinish: ((BoardPencilHoldResult?) -> Void)?
    var onObservation: ((String) -> Void)?
    private var lastObservedPoint: CGPoint?
    private weak var pencil: UITouch?
    private var tracker: BoardPencilLineTracker?
    private var shapeTracker: BoardPencilShapeTracker?
    private var shapeMode: BoardPencilShapeSettings.Shape = .off
    private var duration: TimeInterval = 0.65
    private var checkWork: DispatchWorkItem?
    private var checkID: UUID?

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        let settings = BoardPencilLineSettings.load()
        let shape = BoardPencilShapeSettings.load().shape
        guard pencil == nil, touches.count == 1, let touch = touches.first,
              touch.type == .pencil, (settings.isEnabled || shape != .off), canObserve?(touch) == true else {
            cancelObservation(); state = .failed; return
        }
        duration = settings.holdDuration; pencil = touch; shapeMode = shape
        let point = touch.location(in: coordinateView ?? view)
        lastObservedPoint = point
        onObservation?("tracking")
        if shape == .off { tracker = BoardPencilLineTracker(point: point, time: touch.timestamp) }
        else { shapeTracker = BoardPencilShapeTracker(point: point, time: touch.timestamp, shape: shape) }
        onBegin?(shape)
        scheduleCheck(after: duration)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let pencil, touches.contains(pencil) else { return }
        guard canObserve?(pencil) == true else { cancelObservation(); state = .failed; return }
        let wasConfirmed = confirmedResult != nil
        for touch in event.coalescedTouches(for: pencil) ?? [pencil] {
            let point = touch.location(in: coordinateView ?? view)
            tracker?.append(point, time: touch.timestamp)
            shapeTracker?.append(point, time: touch.timestamp)
            lastObservedPoint = point
        }
        if wasConfirmed, confirmedResult == nil { onPreview?(nil) }
        if confirmedResult == nil { scheduleCheck(after: duration) }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let pencil, touches.contains(pencil) else { return }
        let point = pencil.location(in: coordinateView ?? view)
        // Lift can move the reported tip a few pixels. A previously confirmed
        // hold survives that tiny drift; a real resumed stroke still cancels it.
        if shapeMode == .off {
            _ = tracker?.finish(at: point, time: pencil.timestamp, duration: duration)
        } else {
            _ = shapeTracker?.confirmIfQuiet(at: pencil.timestamp, duration: duration)
            let stableLift = lastObservedPoint.map { hypot(point.x - $0.x, point.y - $0.y) <= 6 } ?? false
            if !stableLift { shapeTracker?.append(point, time: pencil.timestamp) }
        }
        let result = settingsStillMatch && canObserve?(pencil) == true ? confirmedResult : nil
        onObservation?(result == nil ? "liftUnconfirmed" : "liftConfirmed")
        cancelCheck(); self.pencil = nil; tracker = nil; shapeTracker = nil
        onFinish?(result)
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        cancelObservation(); state = .failed
    }

    override func reset() {
        cancelCheck(); pencil = nil; tracker = nil; shapeTracker = nil
        super.reset()
    }

    func cancelObservation() {
        cancelCheck(); pencil = nil; tracker = nil; shapeTracker = nil
        onPreview?(nil); onFinish?(nil)
    }

    private var settingsStillMatch: Bool {
        let line = BoardPencilLineSettings.load()
        return BoardPencilShapeSettings.load().shape == shapeMode
            && (shapeMode != .off || line.isEnabled) && line.holdDuration == duration
    }

    private var confirmedResult: BoardPencilHoldResult? {
        if let shape = shapeTracker?.confirmedShape { return .shape(shape) }
        if let line = tracker?.confirmedLine { return .line(line) }
        return nil
    }

    private func cancelCheck() {
        checkWork?.cancel(); checkWork = nil; checkID = nil
    }

    private func scheduleCheck(after delay: TimeInterval) {
        guard checkWork == nil, pencil != nil else { return }
        let id = UUID()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.checkID == id, let pencil = self.pencil else { return }
            self.checkWork = nil; self.checkID = nil
            guard self.settingsStillMatch, self.canObserve?(pencil) == true else { self.cancelObservation(); return }
            let now = ProcessInfo.processInfo.systemUptime
            guard let movement = self.shapeTracker?.lastMovementTime ?? self.tracker?.lastMovementTime else { return }
            let remaining = self.duration - (now - movement)
            if remaining > 0 { self.scheduleCheck(after: remaining); return }
            _ = self.tracker?.confirmIfQuiet(at: now, duration: self.duration)
            _ = self.shapeTracker?.confirmIfQuiet(at: now, duration: self.duration)
            self.onObservation?(self.confirmedResult == nil ? "outlineNotMatched" : "previewConfirmed")
            self.onPreview?(self.confirmedResult)
        }
        checkID = id; checkWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0.01, delay), execute: work)
    }
}

@MainActor
final class BoardCanvasHost: UIView, PKCanvasViewDelegate, PKToolPickerObserver, TemporaryCanvasSnapshotSource, UIGestureRecognizerDelegate, UIPencilInteractionDelegate {
    static let worldExtent: CGFloat = 8_000_000
    private static weak var activePaletteHost: BoardCanvasHost?
    let isEmbeddedCanvas: Bool
    private let ancestorBoardIDs: Set<UUID>
    private let embeddedDepth: Int
    private var childOverlay: BoardChildCanvasOverlay!
    var onEditItem: ((BoardItem) -> Void)?
    var embeddedViewportDidChange: ((CGPoint, CGFloat) -> Void)?
    var onOpenVideo: ((BoardVideoRequest) -> Void)? { didSet { videoOverlay.onOpen = onOpenVideo } }
    private let videoOverlay = BoardVideoCanvasOverlay()
    var onOpenWeb: ((URL) -> Void)? { didSet { webOverlay.onOpen = onOpenWeb } }
    private let webOverlay = BoardWebCanvasOverlay()
    let canvas = BoardInkCanvasView()
    private var capturedCanvasUndoManager: UndoManager?
    private lazy var readingVideoTap = UITapGestureRecognizer(target: self, action: #selector(openReadingVideo(_:)))
    private let backdrop = BoardBackdropView()
    private var inlineTextSelection: BoardInlineTextSelection!
    private let speechHighlight = BoardReadAloudHighlight()
    private let writingAidOverlay = BoardWritingAidOverlay()
    private var writingAidGeneration = 0
    private var lastWritingAidMode: BoardWritingAidMode = .off
    private var writingAidDraftRestored = false
    private var lastWritingAidCommitID: UUID?
    private var lastWritingAidReturnID: UUID?
    private var lastWritingAidReloadID: UUID?
    private var writingAidInputActive = false
    private var pendingWritingAidCommit: BoardWritingAidDrawingCommit?
    private var writingAidCommitWork: DispatchWorkItem?
    private var aidCommitOutcome = "idle"
    private var aidCommitAttempts = 0, aidCommits = 0
    private lazy var readingOverlayPan = UIPanGestureRecognizer(target: self, action: #selector(panReadingOverlay(_:)))
    private lazy var readingOverlayPinch = UIPinchGestureRecognizer(target: self, action: #selector(pinchReadingOverlay(_:)))
    private var readingPanOffset = CGPoint.zero
    private var readingPinchZoom: CGFloat = 1
    private var readingPinchAnchor = CGPoint.zero
    private var speechHighlightKey: BoardTextSelectionSnapshotKey?
    private var speechHighlightRect: CGRect?
    var allowsReadingTextSelection = true { didSet { if oldValue != allowsReadingTextSelection { synchronizeTextSelection() } } }
    private let interactionSurface = BoardInteractionSurface()
    var mergePlacement: BoardMergePlacementSession?
    private let mergePlacementOverlay = BoardMergePlacementOverlay()
    private let lassoOverlay = BoardLassoOverlay()
    private lazy var lassoViewportPinch = UIPinchGestureRecognizer(target: self, action: #selector(pinchLassoViewport(_:)))
    private var usesNativeStrokeLasso = false
    // Tool ownership is independent of transient busy/first-responder state.
    // A custom mixed lasso must never activate PencilKit's separate native
    // selection/handwriting engine over the same large drawing.
    private var isAppOwnedLassoSelected: Bool {
        picker.selectedToolItem is PKToolPickerLassoItem && !usesNativeStrokeLasso
    }
    private let customLassoIdleTool = PKInkingTool(.pen, color: .black, width: 1)
    private var lassoTypes = Set(UserDefaults.standard.stringArray(forKey: "InkSpace.lassoTypes.v1") ?? ["ink", "document", "video", "image", "text"])
    private var lassoSelection: BoardLassoSelection.Selection?
    private var lassoSnapshot: BoardLassoSelection.Snapshot?
    private var lassoSnapshotInkRevision: UInt64?
    private var lassoSelectionTask: Task<BoardLassoSelection.Selection, Error>?
    private var lassoTransformTask: Task<BoardLassoSelection.Result, Error>?
    private enum LassoClipboardWorkResult {
        case copied(Data, String)
        case inserted(BoardLassoClipboard.Result)
    }
    private struct LassoClipboardUndoState {
        var drawing: PKDrawing
        var items: [BoardItem]
        var edges: [BoardEdge]
        var selection: BoardLassoSelection.Selection
        var canvasSize: CGSize
    }
    private struct LassoClipboardUndoStep {
        var expectedDrawing: PKDrawing
        var replacementDrawing: PKDrawing
        var addedItems: [BoardItem]
        var addedEdges: [BoardEdge]
        var adding: Bool
        var selection: BoardLassoSelection.Selection
        var inverseSelection: BoardLassoSelection.Selection
        var canvasSize: CGSize
    }
    private var lassoClipboardTask: Task<LassoClipboardWorkResult, Error>?
    private var lassoClipboardDiagnostic = "idle"
    private var lassoWorkID: UUID?
    private var lassoWorkActive: Bool { lassoWorkID != nil }
    private var lassoPolygon: [CGPoint] = []
    private var lassoInputDiagnostic = "idle"
    private var lassoInputContext = "source:none"
    private var lassoPathStartCamera = "none"
    private var lassoTransformKind: BoardLassoOverlay.TransformKind?
    private var lassoTransformStart = CGPoint.zero
    private var lassoTransformScale: CGFloat = 1
    private var lassoTransformTranslation = CGSize.zero
    private var lassoTransformAnchor: CGPoint?
    private var lassoPreviewBounds: CGRect?
    private var lassoStatus = ""

    private let reviewSurface = ReviewOverlayView()
    private let insertionMarker = UIImageView(image: UIImage(systemName: "plus.circle.fill"))
    private var picker: PKToolPicker
    private let dockedPalette = BoardDockedPaletteView()
    private var paletteDockSettings = BoardPaletteDockSettings.load()
    private var installedPens: [SavedPen]
    private var installedPaletteEntries: [NativePaletteEntry]
    private var retainedUtilityItems: [PKToolPickerItem] = []
    private var isReconfiguringPicker = true
    private var isUsingDrawingTool = false
    private var nativeStrokeBaseline: PKDrawing?
    private var lastNativeInkChange: TimeInterval = 0
    private let pencilHoldLine = BoardPencilHoldLineGesture()
    private let heldLinePreview = CAShapeLayer()
    private var holdBegins = 0, holdPreviews = 0, holdFinishes = 0, holdCommits = 0
    private var holdOutcome = "idle"
    private struct HeldLineStroke {
        let id = UUID()
        let baseline: PKDrawing
        let zoom: CGFloat
        let offset: CGPoint
        let tool: PKInkingTool
        let shapeMode: BoardPencilShapeSettings.Shape
        var line: BoardPencilHoldResult?
        var retryCount = 0
    }
    private var heldLineStroke: HeldLineStroke?
    private var heldLineCommitWork: DispatchWorkItem?
    private var underlayBaseline: PKDrawing?
    private var underlayWork: DispatchWorkItem?
    private var underlayAttempts = 0
    private var canvasObservesPicker = false
    private var pickerRefreshQueued = false
    private var responderPolicyQueued = false
    private var paletteRestoreRequested = false
    private var lastAppliedPenSelectionRequestID: UUID?
    private var nativePenReflectionRevision = 0
    private var pendingPickerPersistence: DispatchWorkItem?
    private var store: BoardStore
    private let canvasSessionID: UUID
    private var lastDrawing = PKDrawing()
    private var nativeInkRevision: UInt64 = 0
    private var pencilInputBegins = 0
    private var canvasPencilInputBegins = 0
    private var pencilInputEvents = 0
    private var pencilTextRetirements = 0
    private var pencilRoutedHits = 0
    private var lastPencilInputTimestamp: TimeInterval = -1
    private var lastPencilHitTarget = "none"
    private var nativeToolBegins = 0
    private var nativeToolEnds = 0
    private var nativeDrawingChanges = 0
    private var nativeDrawingApplications = 0
    private var lassoOffWindowAttempts = 0
    private var lassoOffWindowAssignments = 0
    private var lassoOffWindowAssignmentUndoPreserved = false
    private var lassoOffWindowAssignmentRegistrationDisabled = false
    private var lassoOffWindowRestores = 0
    private var lassoOffWindowOutcome = "idle"
    private var lassoOffWindowCameraPreserved = false
    private var lassoOffWindowUndoPreserved = false
    private var lassoOffWindowStructurePreserved = false
    private var lassoOffWindowRegistrationPreserved = false
    private var nativeRenderingFinishes = 0
    private var cachedAccessibilityValue: String?
    private var diagnosticBuilds = 0
    private var writingTextSelectionRequested = false
    private var inkCallbackMaxMS: Double = 0
    private var viewportCallbackMaxMS: Double = 0
    private var viewportPaperPrepareMaxMS: Double = 0
    private var viewportPaperDisplayMaxMS: Double = 0
    private var viewportOverlayMaxMS: Double = 0
    private var viewportTextSyncMaxMS: Double = 0
    private var pencilHitMaxMS: Double = 0
    private var pencilDispatchMaxMS: Double = 0
    private var navigationPanBegins = 0
    private var navigationPinchBegins = 0
    private var backdropSynchronizations = 0
    private var lastBackdropSyncKey: BackdropSyncKey?
    private var lastDockedPaletteSettings: BoardPaletteDockSettings?
    private var lastDockedPaletteItems: [BoardDockedPaletteView.Item] = []
    private var applyingDrawing = false
    private var applyingViewport = false
    private var initialViewportApplied = false
    private var viewportRevision = 0
    private var lastCommandID: UUID?
    private var queuedCommandID: UUID?
    private var isTornDown = false
    private var pencilInteraction: UIPencilInteraction?
    private let pencilArc = BoardPencilArcPaletteView()
    private var pencilArcItems: [BoardDockedPaletteView.Item] = []
    private var previousPencilItemIdentifier: String?
    private var lastNonEraserItemIdentifier: String?
    private var pencilTapCount = 0
    private var pencilSqueezeCount = 0
    private var currentMode: BoardMode?
    private var lastPadReading = false
    private var lastImageRevision = -1
    private var lastPreviewEpoch = -1
    private var lastBoardID: UUID?
    private lazy var feedback = UICanvasFeedbackGenerator(view: interactionSurface)
    private var panStartWorld = CGPoint.zero
    private var panStartOffset = CGPoint.zero
    private var dragOrigins: [UUID: CGPoint] = [:]
    private var draggedAnything = false
    private var draggedPrintFrame: BoardPrintFrame?
    private var pinchStartZoom: CGFloat = 1
    private var pinchAnchorWorld = CGPoint.zero

    init(store: BoardStore, embedded: Bool = false, ancestors: Set<UUID> = [], depth: Int = 0) {
        self.store = store
        isEmbeddedCanvas = embedded
        ancestorBoardIDs = ancestors.union([store.document.id])
        embeddedDepth = depth
        canvasSessionID = store.canvasSessionID
        // Native floating mode retains PencilKit's complete interaction handling.
        // Docked mode hides that picker, so it installs one app interaction only
        // while its writing canvas is active. Never run both gesture owners.
        // These public item APIs require iPadOS 18, the app's deployment target.
        let restoredState = Self.loadPickerState()
        let initialItems = Self.paletteItems(pens: store.savedPens, entries: store.nativePaletteEntries, reusing: [], store: store)
        let initialPicker = PKToolPicker(toolItems: initialItems)
        // Ink is drawn over fixed light paper/PDF content. The picker may retain
        // the system's chrome, but its colors must use the paper's appearance.
        initialPicker.colorUserInterfaceStyle = .light
        // iOS 18+ nil explicitly disables native autosave. SavedPen is authoritative:
        // a native cache must never restore an older color/width over a preset edit.
        // Ink is entirely managed by SavedPen; selection and ruler state have a
        // separate small cache. The legacy built-in ink cache is retained intact.
        initialPicker.stateAutosaveName = nil
        initialPicker.showsDrawingPolicyControls = false
        initialPicker.isRulerActive = store.nativePaletteEntries.contains(.ruler) && (restoredState?.rulerActive ?? false)
        let restoredSelection = store.selectedSavedPenID
            .flatMap { id in store.savedPens.first(where: { $0.id == id })?.toolIdentifier }
            ?? (restoredState?.selectedIdentifier).flatMap { identifier in
                identifier.hasPrefix(Self.savedPenPrefix) || identifier == Self.writingAidIdentifier ? nil : identifier
            }
        if let restoredSelection, initialItems.contains(where: { $0.identifier == restoredSelection }) {
            initialPicker.selectedToolItemIdentifier = restoredSelection
        }
        picker = initialPicker
        installedPens = store.savedPens
        installedPaletteEntries = store.nativePaletteEntries
        retainedUtilityItems = initialItems.filter { !($0 is PKToolPickerInkingItem) }
        // Initial restoration already represents the latest persisted selection,
        // including a later native choice. Do not replay an earlier host's request.
        lastAppliedPenSelectionRequestID = store.savedPenSelectionRequest?.id
        super.init(frame: .zero)
        configurePaletteAccessory()
        backgroundColor = UIColor(red: 0.965, green: 0.956, blue: 0.935, alpha: 1)
        clipsToBounds = true
        addSubview(backdrop)
        addSubview(videoOverlay.contentView)
        addSubview(webOverlay.contentView)
        addSubview(canvas)
        addSubview(interactionSurface)
        addSubview(reviewSurface)
        addSubview(videoOverlay)
        addSubview(webOverlay)
        childOverlay = BoardChildCanvasOverlay(store: store, ancestors: ancestorBoardIDs, depth: embeddedDepth)
        addSubview(childOverlay)
        insertionMarker.tintColor = .systemTeal
        insertionMarker.backgroundColor = .systemBackground
        insertionMarker.layer.cornerRadius = 16
        insertionMarker.isUserInteractionEnabled = false
        insertionMarker.accessibilityLabel = String(localized: "文件放置点")
        insertionMarker.accessibilityIdentifier = "canvas.insertionPoint"
        insertionMarker.isAccessibilityElement = true
        addSubview(insertionMarker)
        addSubview(speechHighlight)
        addSubview(writingAidOverlay)
        addSubview(lassoOverlay)
        addSubview(mergePlacementOverlay)
        configureLasso()
        addSubview(dockedPalette)
        configureDockedPalette()
        backdrop.isUserInteractionEnabled = false
        backdrop.store = store
        backdrop.inkInteractionProbe = { [weak self] in
            guard let self, self.ownsCurrentSession else { return false }
            return self.nativeInkInteractionActive
        }
        backdrop.backgroundColor = backgroundColor
        canvas.delegate = self
        canvas.diagnosticValue = { [weak self] in self?.canvasDiagnosticValue() }
        canvas.undoRedoAllowed = { [weak self] in self.map { !$0.lassoWorkActive && !$0.store.isBusy } ?? false }
        canvas.overrideUserInterfaceStyle = .light
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.contentSize = CGSize(width: Self.worldExtent, height: Self.worldExtent)
        canvas.minimumZoomScale = 0.00005
        canvas.maximumZoomScale = 6
        canvas.contentInsetAdjustmentBehavior = .never
        canvas.showsHorizontalScrollIndicator = false
        canvas.showsVerticalScrollIndicator = false
        canvas.bounces = false
        canvas.bouncesZoom = false
        canvas.drawingPolicy = .pencilOnly
        canvas.accessibilityIdentifier = "phone.canvas"
        // Keep the canvas itself observable without enumerating PencilKit's
        // handwriting descendants for automation. VoiceOver and explicit OCR
        // keep their independent accessibility/recognition paths unchanged.
        canvas.automationElements = []
        if store.usesPhoneInterface {
            canvas.isDrawingEnabled = false
        } else {
            // PencilKit owns ink and Pencil Pro interactions. Only touch/pointer
            // input may pan, so a Pencil stroke cannot become a one-touch drag.
            canvas.panGestureRecognizer.allowedTouchTypes = [
                NSNumber(value: UITouch.TouchType.direct.rawValue),
                NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)
            ]
        }
        canvas.panGestureRecognizer.minimumNumberOfTouches = 1
        canvas.drawingGestureRecognizer.addTarget(self, action: #selector(drawingGestureStateDidChange(_:)))
        // Reading taps open media without going through object selection or drag
        // handlers. Canvas pan/pinch retain priority; overlay buttons are siblings
        // of the canvas and do not also trigger this recognizer.
        readingVideoTap.name = "board.reading.video"
        readingVideoTap.cancelsTouchesInView = false
        readingVideoTap.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        readingVideoTap.require(toFail: canvas.panGestureRecognizer)
        if let pinch = canvas.pinchGestureRecognizer { readingVideoTap.require(toFail: pinch) }
        canvas.addGestureRecognizer(readingVideoTap)
        canvas.accessibilityLabel = String(localized: "无限手写白板")
        canvas.accessibilityHint = String(localized: "使用 Apple Pencil 写字，单指移动、双指缩放；停稳后可长按文字选择并复制。")
        // Finger navigation belongs to the common ancestor in both writing and
        // reading: Live Text may intercept hits inside or above PencilKit.
        // These recognizers exclude Pencil; native ink retains its own input.
        readingOverlayPan.maximumNumberOfTouches = 1
        readingOverlayPan.name = "board.reading.overlayPan"
        readingOverlayPinch.name = "board.reading.overlayPinch"
        for gesture: UIGestureRecognizer in [readingOverlayPan, readingOverlayPinch] {
            gesture.delegate = self
            gesture.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
            addGestureRecognizer(gesture)
        }
        inlineTextSelection = BoardInlineTextSelection(content: self)
        inlineTextSelection.retainsCapturedImageForReading = true
        inlineTextSelection.asyncCapture = { [weak self] key in
            await self?.textSelectionSnapshot(for: key)
        }
        inlineTextSelection.canInteract = { [weak self] point in
            guard let self, self.textSelectionEnabled, !self.store.externalInteractionActive,
                  !self.canvas.isDragging, !self.canvas.isDecelerating, !self.canvas.isZooming,
                  !self.textSelectionGestureActive else { return false }
            // Embedded boards own their own text selection, and media controls
            // must retain their ordinary tap/long-press behavior.
            return self.childOverlay?.hitTest(point, with: nil) == nil
                && self.videoOverlay.hitTest(point, with: nil) == nil
                && self.webOverlay.hitTest(point, with: nil) == nil
        }
        inlineTextSelection.onStatus = { [weak self] value in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ownsCurrentSession, self.inlineTextSelection.currentStatus == value else { return }
                self.store.readingTextSelectionStatus = value
                self.updateCanvasAccessibilityValue()
            }
        }
        inlineTextSelection.onSelectionChanged = { [weak self] _ in
            // UIKit can deliver this callback while resetting an old analysis.
            // Re-read the current selection on the next turn, after that reset.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ownsCurrentSession else { return }
                self.synchronizeTextSelection()
            }
        }
        backdrop.onRenderedContentChange = { [weak self] in self?.synchronizeTextSelection() }
        store.readAloud.onHighlight = { [weak self] key, rect in
            guard let self, self.ownsCurrentSession else { return }
            self.speechHighlightKey = key
            self.speechHighlightRect = rect
            self.synchronizeSpeechHighlight()
        }
        canvas.accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: String(localized: "选择白板文字"), target: self, selector: #selector(revealAccessibleText)),
            UIAccessibilityCustomAction(name: String(localized: "复制所选文字"), target: self, selector: #selector(copyAccessibleText))
        ]
        picker.addObserver(self)
        synchronizePickerCanvasOwnership()
        enforcePickerDrawingPermissions()
        isReconfiguringPicker = false
        interactionSurface.onPan = { [weak self] in self?.handlePan($0) }
        interactionSurface.onPinch = { [weak self] in self?.handlePinch($0) }
        interactionSurface.onTap = { [weak self] in self?.handleTap($0) }
        interactionSurface.onDoubleTap = { [weak self] in self?.handleDoubleTap($0) }
        reviewSurface.onStroke = { [weak self] points in
            guard let self, self.ownsCurrentSession, self.store.reviewModeEnabled, self.store.reviews.contextSession == self.canvasSessionID, !self.store.isBusy else { return }
            self.store.reviews.compose(points: points.map { self.worldPoint($0) }, board: self.store.document, zoom: self.canvas.zoomScale)
        }
        reviewSurface.onErase = { [weak self] ids in
            guard let self, self.ownsCurrentSession, self.store.reviewModeEnabled,
                  self.store.reviews.contextSession == self.canvasSessionID, !self.store.isBusy else { return }
            Task { await self.store.reviews.erase(ids) }
        }
        reviewSurface.onNavigatePan = { [weak self] in self?.handlePan($0) }
        reviewSurface.onNavigatePinch = { [weak self] in self?.handlePinch($0) }
        reviewSurface.onTooLong = { [weak self] in self?.store.reviews.status = String(localized: "这次圈画太长，请分成几条批注；尚未保存") }
        if !embedded || store.readingCanvas == nil { store.readingCanvas = self }
        configurePencilHoldLine()
        configureWritingAids()
        synchronize(with: store)
    }

    required init?(coder: NSCoder) { fatalError("Use init(store:)") }

    private var ownsCurrentSession: Bool {
        !isTornDown && canvasSessionID == store.canvasSessionID
    }

    // App-owned lasso input is handled by our ancestor recognizer/overlay, not
    // PencilKit. Keep its keyboard focus off the native handwriting responder.
    private var usesAppLassoResponder: Bool {
        isAppOwnedLassoSelected && !paletteDockSettings.usesSystemPalette
    }

    private var acceptsAppLassoResponder: Bool {
        usesAppLassoResponder && ownsCurrentSession && ownsActivePalette && window != nil
            && !store.isBusy && !store.isPadReading && !store.reviewModeEnabled
            && !store.usesPhoneInterface && store.mode == .ink
    }

    override var canBecomeFirstResponder: Bool { acceptsAppLassoResponder }

    // Read PencilKit's manager before taking focus. Returning only that stored
    // object (or super) prevents the canvas -> host -> canvas responder recursion.
    override var undoManager: UndoManager? {
        if isFirstResponder, usesAppLassoResponder, let capturedCanvasUndoManager { return capturedCanvasUndoManager }
        return super.undoManager
    }

    private var boardUndoManager: UndoManager? {
        if usesAppLassoResponder, let capturedCanvasUndoManager { return capturedCanvasUndoManager }
        return canvas.undoManager
    }

    override var keyCommands: [UIKeyCommand]? {
        guard isFirstResponder, acceptsAppLassoResponder else { return super.keyCommands }
        let undo = UIKeyCommand(input: "z", modifierFlags: .command, action: #selector(undoAppLasso(_:)))
        undo.discoverabilityTitle = String(localized: "撤销")
        undo.wantsPriorityOverSystemBehavior = true
        let redo = UIKeyCommand(input: "z", modifierFlags: [.command, .shift], action: #selector(redoAppLasso(_:)))
        redo.discoverabilityTitle = String(localized: "重做")
        redo.wantsPriorityOverSystemBehavior = true
        return [undo, redo]
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(undoAppLasso(_:)) || action == #selector(redoAppLasso(_:)) {
            guard isFirstResponder, acceptsAppLassoResponder, !lassoWorkActive else { return false }
            return action == #selector(undoAppLasso(_:)) ? boardUndoManager?.canUndo == true : boardUndoManager?.canRedo == true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    @objc private func undoAppLasso(_ command: UIKeyCommand) {
        guard isFirstResponder, acceptsAppLassoResponder, !lassoWorkActive else { return }
        perform(CanvasCommand(action: .undo))
    }

    @objc private func redoAppLasso(_ command: UIKeyCommand) {
        guard isFirstResponder, acceptsAppLassoResponder, !lassoWorkActive else { return }
        perform(CanvasCommand(action: .redo))
    }

    private var inputResponderIsFocused: Bool {
        usesAppLassoResponder ? isFirstResponder : canvas.isFirstResponder
    }

    private func synchronizeInputResponder() {
        guard ownsCurrentSession, ownsActivePalette, window != nil, !store.isBusy,
              !store.isPadReading, !store.reviewModeEnabled, !store.usesPhoneInterface,
              store.mode == .ink else { return }
        if usesAppLassoResponder {
            // Never freeze a pre-focus controller manager for ordinary ink.
            // The native responder's actual history is captured at this handoff.
            if canvas.isFirstResponder || capturedCanvasUndoManager == nil {
                capturedCanvasUndoManager = canvas.undoManager
            }
            if picker.isVisible { picker.setVisible(false, forFirstResponder: canvas) }
            if canvas.isFirstResponder { canvas.resignFirstResponder() }
            if !isFirstResponder { becomeFirstResponder() }
        } else {
            if !canvas.isFirstResponder { canvas.becomeFirstResponder() }
            // PencilKit may establish its own manager on becoming first
            // responder. Native tools always use that actual current manager.
            capturedCanvasUndoManager = canvas.undoManager
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard ownsCurrentSession else { return }
        let oldCenter = viewportWorldCenter
        let oldZoom = canvas.zoomScale
        let previousSize = canvas.bounds.size
        backdrop.frame = bounds
        videoOverlay.contentView.frame = bounds
        videoOverlay.frame = bounds
        webOverlay.contentView.frame = bounds
        webOverlay.frame = bounds
        // Camera changes can cause a parent layout pass without resizing this
        // host. Do not force PencilKit's tile layout again for an unchanged frame.
        if canvas.frame != bounds {
            applyingViewport = true
            canvas.frame = bounds
            canvas.layoutIfNeeded()
            applyingViewport = false
        }
        interactionSurface.frame = bounds
        reviewSurface.frame = bounds
        childOverlay.frame = bounds
        speechHighlight.frame = bounds
        lassoOverlay.frame = bounds
        mergePlacementOverlay.frame = bounds
        synchronizeMergePlacement()
        writingAidOverlay.frame = bounds
        layoutDockedPalette()
        guard bounds.width > 0, bounds.height > 0 else { return }
        if !initialViewportApplied {
            initialViewportApplied = true
            setViewport(center: store.viewportCenter, zoom: store.zoom)
        } else if previousSize != canvas.bounds.size {
            setViewport(center: oldCenter, zoom: oldZoom)
        }
        // A layout-only pass may already have the same camera/content snapshot
        // committed by the gesture callback. Preserve explicit invalidations.
        if lastBackdropSyncKey != backdropSyncKey { refreshBackdrop() }
        else { synchronizeTextSelection() }
        schedulePendingCommand()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil, isFirstResponder { resignFirstResponder() }
        if window == nil { cancelPencilStraightening(); videoOverlay.stop(); webOverlay.stop(); synchronizePencilInteraction() }
        synchronizeTextSelection()
        if window != nil, store.mode == .ink {
            DispatchQueue.main.async { [weak self] in self?.showPalette() }
        }
    }

    func synchronize(with store: BoardStore) {
        guard !isTornDown, canvasSessionID == store.canvasSessionID else {
            cancelPencilStraightening()
            scheduleResponderPolicy()
            inlineTextSelection?.update(nil)
            return
        }
        self.store = store
        synchronizeMergePlacement()
        store.writingAids.attach(root: store.vaultURL, boardID: store.document.id, sessionID: canvasSessionID)
        synchronizeWritingAids()
        if !isEmbeddedCanvas { store.synchronizeChildInputPolicy() }
        scheduleResponderPolicy()
        readingVideoTap.isEnabled = (store.isPadReading || store.usesPhoneInterface) && !store.isBusy && !store.reviewModeEnabled
        applyPhoneInputPolicy()
        reviewSurface.isUserInteractionEnabled = store.reviewModeEnabled
        reviewSurface.captureEnabled = store.reviews.captureEnabled && store.reviews.overlaysVisible
        reviewSurface.color = store.reviews.color
        reviewSurface.style = store.reviews.style
        reviewSurface.eraserEnabled = store.reviews.eraserEnabled
        reviewSurface.strokeWidth = CGFloat(store.reviews.strokeWidth)
        enforcePickerDrawingPermissions()
        if !store.usesPhoneInterface {
            let reading = store.isPadReading
            if canvas.drawingPolicy != .pencilOnly { canvas.drawingPolicy = .pencilOnly }
            if canvas.panGestureRecognizer.minimumNumberOfTouches != 1 { canvas.panGestureRecognizer.minimumNumberOfTouches = 1 }
            if reading {
                canvas.accessibilityLabel = String(localized: "只读白板")
                canvas.accessibilityHint = String(localized: "单指移动，双指缩放；长按文字选择并复制。Apple Pencil 不会添加笔迹。")
            } else {
                canvas.accessibilityLabel = String(localized: "无限手写白板")
                canvas.accessibilityHint = store.childRoot.writingPriorityEnabled
                    ? String(localized: "使用 Apple Pencil 写字，单指移动、双指缩放；需要复制文字时点选择文字。")
                    : String(localized: "使用 Apple Pencil 写字，单指移动、双指缩放；停稳后可长按文字选择并复制。")
                if lastPadReading { paletteRestoreRequested = true }
            }
            lastPadReading = reading
        }

        if !store.usesPhoneInterface, paletteConfigurationChanged || pendingPenSelection != nil { schedulePickerRefresh() }
        backdrop.store = store
        if lastBoardID != store.document.id {
            lastBoardID = store.document.id
            boardUndoManager?.removeAllActions()
            backdrop.invalidatePreviews()
        }
        if lastPreviewEpoch != store.previewEpoch {
            lastPreviewEpoch = store.previewEpoch
            backdrop.invalidatePreviews()
        }
        if lastImageRevision != store.imageRevision {
            lastImageRevision = store.imageRevision
            backdrop.retryPendingPreviews()
        }
        if !nativeInkInteractionActive, store.drawing != lastDrawing {
            clearLassoSelection()
            applyDrawing(store.drawing)
        }
        interactionSurface.allowsTextEditing = store.mode == .arrange && store.canEditBoardContents && onEditItem != nil
        if currentMode != store.mode {
            currentMode = store.mode
            interactionSurface.isHidden = store.mode == .ink || store.isPadReading
            interactionSurface.selectionRect = nil
            interactionSurface.accessibilityLabel = store.mode == .paper ? String(localized: "打印范围整理区域") : String(localized: "白板节点整理区域")
            let requestedMode = store.mode
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ownsCurrentSession, self.store.mode == requestedMode else { return }
                if requestedMode == .ink {
                    self.showPalette()
                } else {
                    self.picker.setVisible(false, forFirstResponder: self.canvas)
                    self.canvas.resignFirstResponder()
                }
            }
        }
        synchronizeDockedPalette()
        synchronizeLasso()
        if lastBackdropSyncKey != backdropSyncKey { refreshBackdrop() }
        else { synchronizeTextSelection() }
        schedulePendingCommand()
    }

    /// UIKit may promote a SwiftUI hosting view when a focused canvas becomes
    /// disabled. Doing that inside updateUIView re-enters SwiftUI's focus graph.
    /// Coalesce all responder changes after the current view transaction, then
    /// read the latest session and policy rather than applying a stale request.
    private func scheduleResponderPolicy() {
        guard !responderPolicyQueued else { return }
        responderPolicyQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.responderPolicyQueued = false
            guard !self.isTornDown else { return }
            let current = self.ownsCurrentSession
            let enabled = current && !self.store.isBusy
            let resign = !enabled || self.store.isPadReading || self.store.reviewModeEnabled
                || self.store.usesPhoneInterface || self.store.mode != .ink
            if resign {
                self.picker.setVisible(false, forFirstResponder: self.canvas)
                if self.canvas.isFirstResponder { self.canvas.resignFirstResponder() }
                if self.isFirstResponder { self.resignFirstResponder() }
            }
            let wasDisabled = !self.isUserInteractionEnabled
            if self.isUserInteractionEnabled != enabled { self.isUserInteractionEnabled = enabled }
            let restore = self.paletteRestoreRequested || wasDisabled
            self.paletteRestoreRequested = false
            if enabled, !resign, self.canvas.isFirstResponder || self.isFirstResponder {
                self.synchronizeInputResponder()
            }
            if enabled, !resign, restore, self.window != nil { self.showPalette() }
        }
    }

    private func schedulePendingCommand() {
        guard ownsCurrentSession, !store.isBusy, initialViewportApplied,
              bounds.width > 0, bounds.height > 0,
              let command = store.command, command.id != lastCommandID,
              command.id != queuedCommandID else { return }
        queuedCommandID = command.id
        // Mark a command consumed only after it can run on the current laid-out host.
        // Retrying from synchronize/layout preserves commands deferred while busy.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.queuedCommandID == command.id { self.queuedCommandID = nil }
            guard self.ownsCurrentSession, !self.store.isBusy, self.initialViewportApplied,
                  self.bounds.width > 0, self.bounds.height > 0,
                  self.store.command?.id == command.id else { return }
            self.lastCommandID = command.id
            self.perform(command)
        }
    }

    // Controlled large-lasso lifecycle experiment: retain this exact canvas and
    // native history. Only the one synchronous drawing assignment leaves window.
    private struct LassoOffWindowState {
        let parent: UIView
        let index: Int
        let window: UIWindow
        let frame: CGRect
        let bounds: CGRect
        let contentSize: CGSize
        let inset: UIEdgeInsets
        let zoom: CGFloat
        let offset: CGPoint
        let undo: UndoManager
        let previousScopedUndo: UndoManager?
        let delegate: AnyObject?
        let gestures: [UIGestureRecognizer]
        let gestureEnabled: [Bool]
    }

    private func prepareLassoOffWindowCommit() -> LassoOffWindowState? {
        lassoOffWindowAttempts += 1
        lassoOffWindowAssignmentUndoPreserved = false
        lassoOffWindowAssignmentRegistrationDisabled = false
        lassoOffWindowCameraPreserved = false
        lassoOffWindowUndoPreserved = false
        lassoOffWindowStructurePreserved = false
        guard ownsCurrentSession, ownsActivePalette, !store.isBusy,
              !store.usesPhoneInterface, !store.isPadReading, !store.reviewModeEnabled,
              store.mode == .ink, usesAppLassoResponder else {
            lassoOffWindowOutcome = "fallback.policy"; return nil
        }
        guard isFirstResponder, !canvas.isFirstResponder else {
            lassoOffWindowOutcome = "fallback.responder"; return nil
        }
        guard !nativeInkInteractionActive, !nativeInkGestureInProgress, !isUsingDrawingTool,
              !canvas.isTracking, !canvas.isDragging, !canvas.isDecelerating, !canvas.isZooming else {
            lassoOffWindowOutcome = "fallback.inputActive"; return nil
        }
        guard let currentWindow = window, canvas.window === currentWindow,
              let parent = canvas.superview, parent === self,
              let index = parent.subviews.firstIndex(where: { $0 === canvas }) else {
            lassoOffWindowOutcome = "fallback.parentOrWindow"; return nil
        }
        guard let undo = boardUndoManager, canvas.undoManager === undo else {
            lassoOffWindowOutcome = "fallback.undoManager"; return nil
        }
        let frame = canvas.frame, bounds = canvas.bounds, size = canvas.contentSize
        let inset = canvas.contentInset, offset = canvas.contentOffset, zoom = canvas.zoomScale
        let geometry: [CGFloat] = [frame.minX, frame.minY, frame.width, frame.height,
            bounds.minX, bounds.minY, bounds.width, bounds.height, size.width, size.height,
            inset.top, inset.left, inset.bottom, inset.right, offset.x, offset.y, zoom]
        guard geometry.allSatisfy(\.isFinite), frame.width > 0, frame.height > 0,
              bounds.width > 0, bounds.height > 0, size.width >= 0, size.height >= 0, zoom > 0 else {
            lassoOffWindowOutcome = "fallback.geometry"; return nil
        }
        let gestures = canvas.gestureRecognizers ?? []
        return LassoOffWindowState(parent: parent, index: index, window: currentWindow,
            frame: frame, bounds: bounds, contentSize: size, inset: inset, zoom: zoom, offset: offset,
            undo: undo, previousScopedUndo: canvas.lassoCommitUndoManager,
            delegate: canvas.delegate as AnyObject?, gestures: gestures,
            gestureEnabled: gestures.map(\.isEnabled))
    }

    private func restoreLassoOffWindowCommit(_ saved: LassoOffWindowState) {
        // Restore the same view and camera before releasing the scoped manager.
        saved.parent.insertSubview(canvas, at: min(saved.index, saved.parent.subviews.count))
        if canvas.frame != saved.frame { canvas.frame = saved.frame }
        if canvas.zoomScale != saved.zoom { canvas.setZoomScale(saved.zoom, animated: false) }
        if canvas.contentSize != saved.contentSize { canvas.contentSize = saved.contentSize }
        if canvas.contentInset != saved.inset { canvas.contentInset = saved.inset }
        if canvas.bounds != saved.bounds { canvas.bounds = saved.bounds }
        if canvas.contentOffset != saved.offset { canvas.setContentOffset(saved.offset, animated: false) }
        for (gesture, enabled) in zip(saved.gestures, saved.gestureEnabled) where gesture.isEnabled != enabled {
            gesture.isEnabled = enabled
        }
        canvas.lassoCommitUndoManager = saved.previousScopedUndo
        let gestures = canvas.gestureRecognizers ?? []
        lassoOffWindowRestores += 1
        lassoOffWindowCameraPreserved = canvas.frame == saved.frame && canvas.bounds == saved.bounds
            && canvas.contentSize == saved.contentSize && canvas.contentInset == saved.inset
            && canvas.zoomScale == saved.zoom && canvas.contentOffset == saved.offset
        // This read happens after restoring the prior bridge, normally nil, so
        // the temporary override cannot hide a changed native history owner.
        lassoOffWindowUndoPreserved = boardUndoManager === saved.undo && canvas.undoManager === saved.undo
        lassoOffWindowStructurePreserved = canvas.superview === saved.parent && canvas.window === saved.window
            && saved.parent.subviews.firstIndex(where: { $0 === canvas }) == saved.index
            && isFirstResponder && !canvas.isFirstResponder
            && (canvas.delegate as AnyObject?) === saved.delegate
            && gestures.count == saved.gestures.count
            && zip(gestures, saved.gestures).allSatisfy { $0 === $1 }
            && zip(saved.gestures, saved.gestureEnabled).allSatisfy { $0.isEnabled == $1 }
    }

    private func applyDrawing(_ drawing: PKDrawing, brieflyDetachForLasso: Bool = false) {
        var detached = brieflyDetachForLasso ? prepareLassoOffWindowCommit() : nil
        let previousApplyingDrawing = applyingDrawing, previousApplyingViewport = applyingViewport
        applyingDrawing = true
        if detached != nil { applyingViewport = true }
        defer {
            if let saved = detached {
                restoreLassoOffWindowCommit(saved)
                lassoOffWindowOutcome = lassoOffWindowCameraPreserved && lassoOffWindowUndoPreserved
                    && lassoOffWindowStructurePreserved ? "restored" : "restored.invariantMismatch"
            }
            applyingViewport = previousApplyingViewport
            applyingDrawing = previousApplyingDrawing
        }
        if let saved = detached {
            canvas.lassoCommitUndoManager = saved.undo
            canvas.removeFromSuperview()
            lassoOffWindowAssignmentUndoPreserved = canvas.undoManager === saved.undo
            lassoOffWindowAssignmentRegistrationDisabled = !saved.undo.isUndoRegistrationEnabled
            if canvas.window == nil, lassoOffWindowAssignmentUndoPreserved,
               lassoOffWindowAssignmentRegistrationDisabled {
                lassoOffWindowAssignments += 1
            } else {
                // Fail closed before assignment. Restore first, then use exactly
                // the original single windowed assignment, never a second try.
                restoreLassoOffWindowCommit(saved)
                detached = nil
                lassoOffWindowOutcome = "fallback.detachedInvariant"
            }
        }
        lastDrawing = drawing
        nativeInkRevision &+= 1
        nativeDrawingApplications += 1
        canvas.drawing = drawing
    }

    private var writingAidToken: BoardWritingAidSessionToken {
        BoardWritingAidSessionToken(sessionID: canvasSessionID, generation: writingAidGeneration, viewportRevision: viewportRevision)
    }

    private func configureWritingAids() {
        writingAidOverlay.attachPencilInput(to: self) { [weak self] touch in
            guard let self, self.ownsCurrentSession, self.store.canEditBoardContents, self.store.mode == .ink,
                  !self.store.isBusy, self.window != nil, let view = touch.view else { return false }
            return view === self.canvas || view.isDescendant(of: self.canvas)
        }
        writingAidOverlay.onCommitDrawing = { [weak self] addition, token in
            guard let self else { return false }
            guard self.acceptsWritingAid(token), !addition.strokes.isEmpty, addition.strokes.count <= 8,
                  self.pendingWritingAidCommit == nil,
                  self.store.writingAids.mode == .fill || self.store.writingAids.mode == .wavy else {
                self.writingAidOverlay.lastDrawingCommitError = BoardWritingAidFailure.changedSession.localizedDescription
                self.aidCommitOutcome = "rejectedAtLift"; self.updateCanvasAccessibilityValue(); return false
            }
            self.pendingWritingAidCommit = BoardWritingAidDrawingCommit(baseline: self.canvas.drawing,
                addition: addition, token: token, mode: self.store.writingAids.mode)
            self.aidCommitOutcome = "queued"; self.aidCommitAttempts = 0
            self.updateWritingAidInteractionLease(); self.scheduleWritingAidCommit()
            self.updateCanvasAccessibilityValue(); return true
        }
        writingAidOverlay.onInputActivity = { [weak self] active in
            guard let self, self.ownsCurrentSession else { return }
            self.writingAidInputActive = active; self.updateWritingAidInteractionLease()
            self.updateCanvasAccessibilityValue()
        }
        writingAidOverlay.onCancelDrawingCommit = { [weak self] token in
            guard let self, self.pendingWritingAidCommit?.token == token else { return }
            self.finishWritingAidCommit(error: BoardWritingAidFailure.changedSession.localizedDescription, outcome: "inputCancelled")
        }
        writingAidOverlay.onCreateText = { [weak self] submission in
            guard let self, self.acceptsWritingAid(submission.token),
                  self.store.writingAids.mode == .scribble, !submission.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  submission.text.utf8.count <= 100_000 else { return false }
            let width = min(480, self.store.document.canvasWidth)
            let height = min(800, max(100, Double(submission.text.count / 28 + 2) * submission.fontSize * 1.4))
            let item = BoardItem(kind: .text,
                x: min(max(0, submission.worldAnchor.x - width / 2), self.store.document.canvasWidth - width),
                y: min(max(0, submission.worldAnchor.y - height / 2), self.store.document.canvasHeight - height),
                width: width, height: height, title: String(localized: "手写文字"), text: submission.text,
                style: BoardItemStyle(fontSize: submission.fontSize))
            self.store.addItem(item)
            self.store.writingAids.rememberDraft("", boardID: self.store.document.id)
            return self.store.document.items.contains { $0.id == item.id }
        }
        writingAidOverlay.onTapesChange = { [weak self] document, token in
            guard let self, self.ownsCurrentSession else { return false }
            guard self.acceptsWritingAid(token) else {
                _ = self.store.writingAids.rememberTapeDraft(document, token: token)
                return false
            }
            let accepted = self.store.writingAids.saveTapes(document, token: token) { [weak self] committed, error in
                self?.writingAidOverlay.finishTapeSave(committed: committed, token: token, expectedDraft: document, error: error)
            }
            if !accepted { _ = self.store.writingAids.rememberTapeDraft(document, token: token) }
            return accepted
        }
        writingAidOverlay.onDraftChanged = { [weak self] boardID, text in
            guard let self, self.ownsCurrentSession else { return }
            self.store.writingAids.rememberDraft(text, boardID: boardID)
        }
        writingAidOverlay.onStatus = { [weak self] status in
            guard let self, self.ownsCurrentSession else { return }
            self.store.writingAids.status = status; self.store.status = status
        }
        writingAidOverlay.onCloseScribble = { [weak self] in
            self?.store.writingAids.selectMode(.off); self?.synchronizeWritingAids()
        }
    }

    private func acceptsWritingAid(_ token: BoardWritingAidSessionToken) -> Bool {
        ownsCurrentSession && token == writingAidToken && store.canEditBoardContents && !store.isBusy
            && store.mode == .ink && !canvas.isDragging && !canvas.isZooming
    }

    private func updateWritingAidInteractionLease() {
        guard ownsCurrentSession else { return }
        let gestures: [UIGestureRecognizer?] = [readingOverlayPan, readingOverlayPinch, canvas.panGestureRecognizer,
                                               canvas.pinchGestureRecognizer, lassoViewportPinch]
        let navigating = gestures.compactMap { $0 }.contains { $0.state == .began || $0.state == .changed }
        store.externalInteractionActive = writingAidInputActive || pendingWritingAidCommit != nil
            || nativeInkInteractionActive || navigating || lassoOverlay.isInteracting
    }

    private func scheduleWritingAidCommit() {
        guard writingAidCommitWork == nil, let pending = pendingWritingAidCommit else { return }
        let id = pending.id
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pendingWritingAidCommit?.id == id else { return }
            self.writingAidCommitWork = nil; self.commitWritingAidIfReady()
        }
        writingAidCommitWork = work
        // Gesture target actions run inside UIKit's event/undo group. Let the
        // run loop finish it; never close or append to a PencilKit-owned group.
        DispatchQueue.main.asyncAfter(deadline: .now()+0.025, execute: work)
    }

    private func commitWritingAidIfReady() {
        guard var pending = pendingWritingAidCommit else { return }
        let undo = boardUndoManager
        let readiness = pending.readiness(current: canvas.drawing, token: writingAidToken,
            mode: store.writingAids.mode, canEdit: ownsCurrentSession && store.canEditBoardContents && !store.isBusy
                && store.mode == .ink && !canvas.isDragging && !canvas.isZooming,
            nativeInkActive: nativeInkInteractionActive, undoGroupingLevel: undo?.groupingLevel,
            undoEnabled: undo?.isUndoRegistrationEnabled == true)
        pendingWritingAidCommit = pending; aidCommitAttempts = pending.attempts; aidCommitOutcome = readiness.rawValue
        switch readiness {
        case .waitingForNativeUndo: scheduleWritingAidCommit(); updateCanvasAccessibilityValue()
        case .cancelled, .expired:
            finishWritingAidCommit(error: readiness == .expired
                ? String(localized: "画布尚未完成上一次操作，本次辅助笔未添加，请抬笔后重画。")
                : BoardWritingAidFailure.changedSession.localizedDescription, outcome: readiness.rawValue)
        case .ready:
            guard let undo else { return }
            let replacement = pending.replacementForRendering()
            undo.beginUndoGrouping()
            restoreHeldLineDrawing(replacement, replacing: pending.baseline, actionName: pending.mode.title)
            undo.endUndoGrouping()
            guard BoardHeldLineStroke.hasSameStrokes(canvas.drawing,replacement) else {
                finishWritingAidCommit(error: String(localized: "辅助笔未能添加到当前画布，请重画。"), outcome: "assignmentRejected"); return
            }
            aidCommits += 1
            finishWritingAidCommit(error: nil, outcome: "committed")
        }
    }

    private func finishWritingAidCommit(error: String?, outcome: String) {
        guard let pending = pendingWritingAidCommit else { return }
        writingAidCommitWork?.cancel(); writingAidCommitWork = nil; pendingWritingAidCommit = nil
        aidCommitOutcome = outcome; updateWritingAidInteractionLease()
        writingAidOverlay.finishDrawingCommit(token: pending.token,error: error)
        if error == nil {
            let message = pending.mode == .fill ? String(localized: "闭合填色已添加，可撤销或擦除。") : String(localized: "波浪线已添加，可撤销或擦除。")
            store.writingAids.status = message; store.status = message
        }
        updateCanvasAccessibilityValue()
    }

    private func synchronizeWritingAids() {
        guard ownsCurrentSession else { writingAidOverlay.cancelInput(); return }
        let controller = store.writingAids
        if let request = controller.tapeReloadRequest, request != lastWritingAidReloadID {
            lastWritingAidReloadID = request
            writingAidOverlay.discardUnsavedTape()
        }
        if let request = controller.nativeInkRequest, request != lastWritingAidReturnID {
            lastWritingAidReturnID = request
            if picker.selectedToolItemIdentifier == Self.writingAidIdentifier,
               let ordinary = picker.toolItems.first(where: { $0.identifier == lastNonEraserItemIdentifier && $0 is PKToolPickerInkingItem })
                    ?? picker.toolItems.first(where: { $0 is PKToolPickerInkingItem || $0 is PKToolPickerEraserItem }) {
                picker.selectedToolItemIdentifier = ordinary.identifier
                applySelectedPickerTool()
            }
        }
        if let commit = controller.lastTapeCommit, commit.id != lastWritingAidCommitID {
            lastWritingAidCommitID = commit.id
            writingAidOverlay.finishTapeSave(committed: commit.document, token: commit.token, expectedDraft: commit.draft, error: commit.error)
            if let document = commit.document {
                writingAidOverlay.synchronizeCommittedTapes(document, sessionID: commit.token.sessionID)
            }
        }
        let mode: BoardWritingAidMode = store.canEditBoardContents && store.mode == .ink ? controller.mode : .off
        if mode != lastWritingAidMode {
            writingAidGeneration &+= 1; lastWritingAidMode = mode
            nativePenReflectionRevision += 1
            if mode != .off, picker.toolItems.contains(where: { $0.identifier == Self.writingAidIdentifier }) {
                // The explicit auxiliary choice owns the mode. A queued native
                // reflection of the previously selected eraser must not exit it.
                isReconfiguringPicker = true
                picker.selectedToolItemIdentifier = Self.writingAidIdentifier
                isReconfiguringPicker = false
            }
            cancelPencilStraightening(); inlineTextSelection?.update(nil)
        }
        if mode == .off, writingAidOverlay.mode == .off, controller.tapes?.tapes.isEmpty != false, !writingAidOverlay.hasTapeContent { return }
        let tool = (canvas.tool as? PKInkingTool)
            ?? (picker.toolItems.first(where: { $0.identifier == lastNonEraserItemIdentifier }) as? PKToolPickerInkingItem)?.inkingTool
            ?? (picker.toolItems.first(where: { $0 is PKToolPickerInkingItem }) as? PKToolPickerInkingItem)?.inkingTool
            ?? PKInkingTool(.pen, color: .label, width: 3)
        let aidZoom = canvas.zoomScale, aidOffset = canvas.contentOffset
        writingAidOverlay.update(context: .init(boardID: store.document.id, token: writingAidToken,
            canEdit: ownsCurrentSession && store.canEditBoardContents && !store.isBusy && store.mode == .ink,
            zoom: canvas.zoomScale, worldSize: CGSize(width: store.document.canvasWidth, height: store.document.canvasHeight),
            ink: PKInk(tool.inkType, color: tool.color), width: tool.width,
            screenToWorld: { point in CGPoint(x: (point.x+aidOffset.x)/aidZoom, y: (point.y+aidOffset.y)/aidZoom) },
            worldToScreen: { point in CGPoint(x: point.x*aidZoom-aidOffset.x, y: point.y*aidZoom-aidOffset.y) }),
            mode: mode, settings: controller.settings, tapes: controller.tapes)
        if mode == .scribble, !writingAidDraftRestored {
            writingAidDraftRestored = true
            writingAidOverlay.restoreScribbleDraft(controller.draft(boardID: store.document.id), worldAnchor: viewportWorldCenter)
        }
        enforcePickerDrawingPermissions()
    }

    private func presentWritingAidSettings() {
        let controller = UIHostingController(rootView: NavigationStack {
            BoardWritingAidSettingsView(controller: store.writingAids, canEdit: store.canEditBoardContents)
        })
        controller.preferredContentSize = CGSize(width: 360, height: 480)
        dockedPalette.presentQuickSettings(controller, for: Self.writingAidIdentifier)
    }

    private func configurePencilHoldLine() {
        heldLinePreview.fillColor = nil
        heldLinePreview.lineCap = .round; heldLinePreview.lineJoin = .round
        heldLinePreview.isHidden = true
        layer.addSublayer(heldLinePreview)
        pencilHoldLine.coordinateView = self
        pencilHoldLine.cancelsTouchesInView = false
        pencilHoldLine.delaysTouchesBegan = false; pencilHoldLine.delaysTouchesEnded = false
        pencilHoldLine.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        pencilHoldLine.canObserve = { [weak self] touch in
            guard let self, self.ownsCurrentSession, self.window != nil, self.store.canEditBoardContents,
                  !self.store.isBusy, self.store.mode == .ink, !self.writingAidOverlay.capturesPencil, !self.canvas.isRulerActive,
                  !self.canvas.isDragging, !self.canvas.isDecelerating, !self.canvas.isZooming,
                  self.canvas.tool is PKInkingTool, let view = touch.view else { return false }
            return view === self.canvas || view.isDescendant(of: self.canvas)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(pencilAssistSettingsDidChange),
            name: .boardPencilAssistSettingsChanged, object: nil)
        pencilHoldLine.onObservation = { [weak self] event in
            guard let self else { return }
            self.holdOutcome = event
            if event == "tracking" { self.holdBegins += 1 }
            if event == "previewConfirmed" { self.holdPreviews += 1 }
            if event == "liftConfirmed" { self.holdFinishes += 1 }
            self.updateCanvasAccessibilityValue()
        }
        pencilHoldLine.onBegin = { [weak self] shapeMode in
            guard let self, let tool = self.canvas.tool as? PKInkingTool else { return }
            self.cancelHeldLineReplacement()
            // PKDrawing is a value snapshot; no old strokes are enumerated here.
            let baseline = self.nativeInkInteractionActive ? self.nativeStrokeBaseline ?? self.lastDrawing : self.lastDrawing
            self.heldLineStroke = HeldLineStroke(baseline: baseline,
                zoom: self.canvas.zoomScale, offset: self.canvas.contentOffset, tool: tool, shapeMode: shapeMode)
        }
        pencilHoldLine.onPreview = { [weak self] line in
            guard let self else { return }
            guard let line, let stroke = self.heldLineStroke,
                  self.ownsCurrentSession, self.canvas.zoomScale == stroke.zoom,
                  self.canvas.contentOffset == stroke.offset else {
                self.heldLinePreview.isHidden = true; return
            }
            let path = UIBezierPath()
            guard let start = line.points.first else { return }
            path.move(to: start)
            for point in line.points.dropFirst() { path.addLine(to: point) }
            CATransaction.begin(); CATransaction.setDisableActions(true)
            self.heldLinePreview.path = path.cgPath
            self.heldLinePreview.strokeColor = stroke.tool.color.cgColor
            self.heldLinePreview.lineWidth = max(1, stroke.tool.width * stroke.zoom)
            self.heldLinePreview.isHidden = false
            CATransaction.commit()
        }
        pencilHoldLine.onFinish = { [weak self] line in
            guard let self else { return }
            guard let line, self.heldLineStroke != nil else { self.cancelHeldLineReplacement(); return }
            self.heldLineStroke?.line = line
            self.scheduleHeldLineCommit()
        }
        addGestureRecognizer(pencilHoldLine)
    }

    @objc private func pencilAssistSettingsDidChange() {
        // Both off and a shape change retire the active observer timer, preview,
        // and any lift-commit retry; no previous mode can modify a later stroke.
        cancelPencilStraightening()
    }

    private func cancelHeldLineReplacement() {
        heldLineCommitWork?.cancel(); heldLineCommitWork = nil
        heldLineStroke = nil; heldLinePreview.isHidden = true
    }

    private func cancelPencilStraightening() {
        pencilHoldLine.cancelObservation()
        cancelHeldLineReplacement()
    }

    private func scheduleHeldLineCommit() {
        guard heldLineCommitWork == nil, let stroke = heldLineStroke, stroke.line != nil else { return }
        guard stroke.retryCount < 80 else { holdOutcome = "commitWaitExpired"; cancelHeldLineReplacement(); return }
        heldLineStroke?.retryCount += 1
        let id = stroke.id
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.heldLineStroke?.id == id else { return }
            self.heldLineCommitWork = nil
            self.commitHeldLineIfReady()
        }
        heldLineCommitWork = work
        // Final Pencil pressure and the native stroke undo group can arrive after tool-end.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.025, execute: work)
    }

    private func commitHeldLineIfReady() {
        guard let candidate = heldLineStroke, let line = candidate.line else { return }
        guard ownsCurrentSession, store.canEditBoardContents, !store.isBusy, store.mode == .ink,
              BoardPencilShapeSettings.load().shape == candidate.shapeMode,
              (candidate.shapeMode != .off || BoardPencilLineSettings.load().isEnabled),
              canvas.zoomScale == candidate.zoom, canvas.contentOffset == candidate.offset,
              !canvas.isDragging, !canvas.isDecelerating, !canvas.isZooming,
              (canvas.tool as? PKInkingTool) == candidate.tool else { cancelHeldLineReplacement(); return }
        guard !nativeInkInteractionActive else { scheduleHeldLineCommit(); return }
        // Leave a short quiet interval for PencilKit's final estimated pressure.
        guard CACurrentMediaTime() - lastNativeInkChange >= 0.06 else { scheduleHeldLineCommit(); return }
        let original = canvas.drawing
        if BoardHeldLineStroke.hasSameStrokes(original, candidate.baseline) { scheduleHeldLineCommit(); return }
        guard let last = BoardHeldLineStroke.appendedStroke(in: original, after: candidate.baseline),
              last.ink.inkType == candidate.tool.inkType,
              last.ink.color == candidate.tool.color,
              let undo = boardUndoManager, undo.isUndoRegistrationEnabled else {
            cancelHeldLineReplacement(); return
        }
        let assistedStroke: PKStroke?
        switch line {
        case .line(let held):
            assistedStroke = BoardHeldLineStroke.straightened(last, screenZoom: candidate.zoom,
                screenOffset: candidate.offset, matching: held)
        case .shape(let held):
            assistedStroke = BoardHeldLineStroke.shaped(last, screenZoom: candidate.zoom,
                screenOffset: candidate.offset, matching: held)
        }
        guard var straight = assistedStroke else { holdOutcome = "nativePathNotMatched"; cancelHeldLineReplacement(); return }
        // PencilKit can reuse a cached native image for a same-ID changed path.
        if #available(iOS 27.0, *) { straight.id = UUID() }
        else { straight = PKStroke(ink: straight.ink, path: straight.path, transform: straight.transform,
                                  mask: straight.mask, randomSeed: straight.randomSeed) }
        // Never close a group owned by PencilKit. A separate edit lets one Undo
        // restore the original pressure-bearing curve, and the next remove it.
        guard undo.groupingLevel == 0 else { holdOutcome = "waitingForNativeUndo"; scheduleHeldLineCommit(); return }
        let assisted = PKDrawing(strokes: Array(original.strokes.dropLast()) + [straight])
        let replacement = BoardHighlighterUnderlay.applyingCompletedSuffix(to: assisted, after: underlayBaseline ?? candidate.baseline,
            enabled: BoardHighlighterUnderlaySettings.load().isEnabled)?.drawing ?? assisted
        cancelHighlighterUnderlay()
        cancelHeldLineReplacement()
        guard !BoardHeldLineStroke.hasSameStrokes(replacement, original) else { return }
        undo.beginUndoGrouping()
        restoreHeldLineDrawing(replacement, replacing: original,
            actionName: candidate.shapeMode == .off ? String(localized: "停笔拉直") : String(localized: "几何辅助"))
        undo.endUndoGrouping()
        holdCommits += 1; holdOutcome = "committed"; updateCanvasAccessibilityValue()
    }

    private func cancelHighlighterUnderlay() {
        underlayWork?.cancel(); underlayWork = nil; underlayBaseline = nil; underlayAttempts = 0
    }

    private func scheduleHighlighterUnderlay() {
        guard underlayWork == nil, underlayBaseline != nil else { return }
        guard underlayAttempts < 32 else { cancelHighlighterUnderlay(); return }
        underlayAttempts += 1
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.underlayWork = nil
            guard self.ownsCurrentSession, self.store.canEditBoardContents, !self.store.isBusy,
                  self.store.mode == .ink, BoardHighlighterUnderlaySettings.load().isEnabled,
                  !self.writingAidOverlay.capturesPencil else { self.cancelHighlighterUnderlay(); return }
            guard !self.nativeInkInteractionActive, self.heldLineStroke == nil,
                  CACurrentMediaTime() - self.lastNativeInkChange >= 0.08,
                  self.boardUndoManager?.groupingLevel == 0 else { self.scheduleHighlighterUnderlay(); return }
            guard let baseline = self.underlayBaseline else { return }
            let original = self.canvas.drawing
            let replacement = BoardHighlighterUnderlay.applyingCompletedSuffix(to: original, after: baseline, enabled: true)?.drawing
            self.cancelHighlighterUnderlay()
            guard let replacement, let undo = self.boardUndoManager, undo.isUndoRegistrationEnabled else { return }
            undo.beginUndoGrouping()
            self.restoreHeldLineDrawing(replacement, replacing: original, actionName: String(localized: "荧光笔置底"))
            undo.endUndoGrouping()
        }
        underlayWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
    }

    private func restoreHeldLineDrawing(_ drawing: PKDrawing, replacing expected: PKDrawing, actionName: String) {
        guard ownsCurrentSession, store.canEditBoardContents, !store.isBusy,
              !nativeInkInteractionActive, BoardHeldLineStroke.hasSameStrokes(canvas.drawing, expected),
              let undo = boardUndoManager, undo.isUndoRegistrationEnabled else { return }
        undo.registerUndo(withTarget: self) { host in
            host.restoreHeldLineDrawing(expected, replacing: drawing, actionName: actionName)
        }
        undo.setActionName(actionName)
        undo.disableUndoRegistration()
        applyDrawing(drawing)
        undo.enableUndoRegistration()
        store.drawing = drawing
        markInkChanged()
        synchronizeTextSelection()
    }

    private var nativeInkInteractionActive: Bool {
        isUsingDrawingTool || nativeInkGestureInProgress
    }

    /// Auxiliary page work may yield to actual ink without delaying navigation.
    var snapshotInkInteractionActive: Bool { nativeInkInteractionActive }

    private var nativeInkGestureInProgress: Bool {
        canvas.drawingGestureRecognizer.state == .began || canvas.drawingGestureRecognizer.state == .changed
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        let started = CACurrentMediaTime()
        defer { inkCallbackMaxMS = max(inkCallbackMaxMS, (CACurrentMediaTime() - started) * 1000) }
        nativeDrawingChanges += 1
        guard !applyingDrawing, ownsCurrentSession else { return }
        if !store.canEditBoardContents { if canvasView.drawing != store.drawing { applyDrawing(store.drawing) }; return }
        guard !store.reviewModeEnabled, !store.isBusy, canvasView.drawing != lastDrawing else { return }
        lastNativeInkChange = CACurrentMediaTime()
        clearLassoSelection()
        lastDrawing = canvasView.drawing
        nativeInkRevision &+= 1
        store.drawing = lastDrawing
        markInkChanged()
        updateCanvasAccessibilityValue()
        if heldLineStroke?.line != nil { scheduleHeldLineCommit() }
    }

    func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
        nativeToolBegins += 1
        updateCanvasAccessibilityValue()
        guard ownsCurrentSession, !store.isBusy, store.canEditBoardContents else { return }
        let underlayEnabled = BoardHighlighterUnderlaySettings.load().isEnabled
        if underlayEnabled, underlayBaseline != nil {
            // Keep completed markers pending across rapid consecutive strokes.
            underlayWork?.cancel(); underlayWork = nil; underlayAttempts = 0
        } else { cancelHighlighterUnderlay() }
        nativeStrokeBaseline = lastDrawing
        if underlayEnabled, underlayBaseline == nil,
           (canvasView.tool as? PKInkingTool)?.inkType == .marker {
            underlayBaseline = lastDrawing
        }
        isUsingDrawingTool = true
        store.externalInteractionActive = true
        synchronizeTextSelection()
        activateInputPalette()
    }

    func canvasViewDidFinishRendering(_ canvasView: PKCanvasView) {
        guard ownsCurrentSession else { return }
        nativeRenderingFinishes += 1
        updateCanvasAccessibilityValue()
    }

    func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
        nativeToolEnds += 1
        guard ownsCurrentSession else { return }
        defer {
            isUsingDrawingTool = false
            nativeStrokeBaseline = nil
            updateWritingAidInteractionLease()
            reconcileDockedPickerTool()
            synchronizeTextSelection()
            if !store.usesPhoneInterface, paletteConfigurationChanged || pendingPenSelection != nil { schedulePickerRefresh() }
            if heldLineStroke?.line != nil { scheduleHeldLineCommit() }
            scheduleHighlighterUnderlay()
        }
        guard !store.isBusy, store.canEditBoardContents else { return }
        if canvasView.drawing != lastDrawing {
            lastNativeInkChange = CACurrentMediaTime()
            lastDrawing = canvasView.drawing
            nativeInkRevision &+= 1
            store.drawing = lastDrawing
        }
        markInkChanged()
    }

    @objc private func drawingGestureStateDidChange(_ recognizer: UIGestureRecognizer) {
        guard ownsCurrentSession else { return }
        switch recognizer.state {
        case .ended, .cancelled, .failed:
            // Tool-end normally publishes the final ink first. The recognizer
            // is only a fallback for cancellation, after PencilKit's callbacks.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ownsCurrentSession, !self.nativeInkGestureInProgress else { return }
                self.isUsingDrawingTool = false
                self.nativeStrokeBaseline = nil
                self.updateWritingAidInteractionLease()
                self.reconcileDockedPickerTool()
                self.synchronizeTextSelection()
                if !self.store.usesPhoneInterface, self.paletteConfigurationChanged || self.pendingPenSelection != nil { self.schedulePickerRefresh() }
            }
        default:
            break
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { viewportDidChange() }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { viewportDidChange() }
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        guard ownsCurrentSession else { return }
        backdrop.finishViewportInteraction()
    }

    private func viewportDidChange(userInitiated: Bool = false) {
        let started = CACurrentMediaTime()
        defer { viewportCallbackMaxMS = max(viewportCallbackMaxMS, (CACurrentMediaTime() - started) * 1000) }
        guard initialViewportApplied, ownsCurrentSession, !applyingViewport else { return }
        if let stroke = heldLineStroke,
           stroke.zoom != canvas.zoomScale || stroke.offset != canvas.contentOffset { cancelPencilStraightening() }
        // Deceleration can continue after saving disables interaction. Keep the
        // PDF/background in step with native ink even while model writes are busy.
        if lastBackdropSyncKey != backdropSyncKey {
            refreshBackdrop(synchronizeViewport: true)
        } else {
            synchronizeTextSelection()
        }
        guard !store.isBusy else { return }
        // UIKit can report delayed scroll/zoom callbacks for layout and restoration.
        // Only user gestures make those callbacks edits; explicit commands mark themselves.
        guard userInitiated || canvas.isTracking || canvas.isDragging || canvas.isDecelerating || canvas.isZooming else { return }
        viewportRevision += 1
        synchronizeWritingAids()
        publishViewport(center: viewportWorldCenter, zoom: canvas.zoomScale)
        if isEmbeddedCanvas {
            embeddedViewportDidChange?(viewportWorldCenter, canvas.zoomScale)
            return
        }
        if store.canEditBoardContents { markViewportChanged() }
    }

    private func publishViewport(center: CGPoint, zoom: CGFloat) {
        guard ownsCurrentSession, !store.isBusy, initialViewportApplied else { return }
        guard !isEmbeddedCanvas else { return }
        if store.viewportCenter != center { store.viewportCenter = center }
        if store.zoom != zoom { store.zoom = zoom }
    }

    private var viewportWorldCenter: CGPoint {
        worldPoint(CGPoint(x: canvas.bounds.width / 2, y: canvas.bounds.height / 2))
    }

    private func worldPoint(_ screenPoint: CGPoint) -> CGPoint {
        let zoom = max(canvas.zoomScale, canvas.minimumZoomScale)
        return CGPoint(x: (screenPoint.x + canvas.contentOffset.x) / zoom,
                       y: (screenPoint.y + canvas.contentOffset.y) / zoom)
    }

    private func setViewport(center: CGPoint, zoom: CGFloat) {
        guard ownsCurrentSession, bounds.width > 0, bounds.height > 0,
              center.x.isFinite, center.y.isFinite, zoom.isFinite else { return }
        viewportRevision += 1
        synchronizeWritingAids()
        applyingViewport = true
        canvas.setZoomScale(min(canvas.maximumZoomScale, max(canvas.minimumZoomScale, zoom)), animated: false)
        let offset = CGPoint(x: center.x * canvas.zoomScale - canvas.bounds.width / 2,
                             y: center.y * canvas.zoomScale - canvas.bounds.height / 2)
        setClampedOffset(offset)
        applyingViewport = false
        let appliedCenter = viewportWorldCenter
        let appliedZoom = canvas.zoomScale
        let revision = viewportRevision
        // Layout may run inside a SwiftUI update. Publish this operation's snapshot,
        // never a later canvas value, and discard it after any newer viewport change.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.ownsCurrentSession, !self.store.isBusy,
                  self.viewportRevision == revision else { return }
            self.publishViewport(center: appliedCenter, zoom: appliedZoom)
        }
        refreshBackdrop(synchronizeViewport: true)
    }

    private func setClampedOffset(_ offset: CGPoint) {
        let width = Self.worldExtent * canvas.zoomScale
        let height = Self.worldExtent * canvas.zoomScale
        canvas.setContentOffset(CGPoint(
            x: min(max(0, offset.x), max(0, width - canvas.bounds.width)),
            y: min(max(0, offset.y), max(0, height - canvas.bounds.height))
        ), animated: false)
    }

    /// Ink has its own revision and does not change these presentation inputs.
    /// Node edits still use document.updatedAt, while direct selection, review,
    /// printing and viewport changes remain explicit members of this key.
    private struct BackdropSyncKey: Equatable {
        let boardID: UUID
        let sessionID: UUID
        let updatedAt: Date
        let documentRevision: Int
        let previewEpoch: Int
        let imageRevision: Int
        let size: CGSize
        let displayScale: CGFloat
        let zoom: CGFloat
        let offset: CGPoint
        let selectedIDs: Set<UUID>
        let mode: BoardMode
        let reading: Bool
        let phoneMarkup: Bool
        let busy: Bool
        let reviewMode: Bool
        let reviewsVisible: Bool
        let reviewsBound: Bool
        let reviewRecords: [BoardReview]
        let reviewDraft: BoardReview?
        let selectedReviewID: UUID?
        let insertionPoint: CGPoint?
        let printFrames: [BoardPrintFrame]
        let selectedPrintFrameID: UUID?
        let showsPrintFrames: Bool
        let childRevision: Int
        let vaultURL: URL?
    }

    private var backdropSyncKey: BackdropSyncKey {
        BackdropSyncKey(boardID: store.document.id, sessionID: canvasSessionID,
            updatedAt: store.document.updatedAt, documentRevision: store.document.revision,
            previewEpoch: store.previewEpoch, imageRevision: store.imageRevision,
            size: bounds.size, displayScale: window?.screen.scale ?? traitCollection.displayScale,
            zoom: canvas.zoomScale, offset: canvas.contentOffset, selectedIDs: store.selectedIDs,
            mode: store.mode, reading: store.isPadReading, phoneMarkup: store.phoneMarkupEnabled,
            busy: store.isBusy, reviewMode: store.reviewModeEnabled,
            reviewsVisible: store.reviews.overlaysVisible,
            reviewsBound: store.reviews.isBound(boardID: store.document.id, session: canvasSessionID),
            reviewRecords: store.reviews.records, reviewDraft: store.reviews.draft,
            selectedReviewID: store.reviews.selectedID, insertionPoint: store.insertionPoint,
            printFrames: store.printFrames, selectedPrintFrameID: store.selectedPrintFrameID,
            showsPrintFrames: store.showsPrintFrames, childRevision: store.childRoot.childSessionRevision,
            vaultURL: store.vaultURL)
    }

    private func refreshBackdrop(synchronizeViewport: Bool = false) {
        lastBackdropSyncKey = backdropSyncKey
        backdropSynchronizations += 1
        let zoom = max(canvas.zoomScale, 0.00005)
        let offset = canvas.contentOffset
        let viewportChanged = backdrop.zoom != zoom || backdrop.offset != offset
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        backdrop.zoom = zoom
        backdrop.offset = offset
        let prepareStarted = CACurrentMediaTime()
        backdrop.prepareVisibleItems(deferPreviewRequests: synchronizeViewport && viewportChanged)
        viewportPaperPrepareMaxMS = max(viewportPaperPrepareMaxMS, (CACurrentMediaTime() - prepareStarted) * 1000)
        backdrop.setNeedsDisplay()
        if synchronizeViewport && viewportChanged {
            // The backdrop is a screen-sized sibling of PKCanvasView. Commit
            // its cached pixels in the scroll transaction, not a later display
            // phase that lets PDF pages trail the already-moved native ink.
            let displayStarted = CACurrentMediaTime()
            backdrop.layer.displayIfNeeded()
            viewportPaperDisplayMaxMS = max(viewportPaperDisplayMaxMS, (CACurrentMediaTime() - displayStarted) * 1000)
        }
        let overlaysStarted = CACurrentMediaTime()
        videoOverlay.synchronize(store: store, zoom: max(canvas.zoomScale, 0.00005), offset: canvas.contentOffset)
        webOverlay.synchronize(store: store, zoom: max(canvas.zoomScale, 0.00005), offset: canvas.contentOffset)
        childOverlay?.synchronize(zoom: max(canvas.zoomScale, 0.00005), offset: canvas.contentOffset)
        reviewSurface.zoom = canvas.zoomScale
        reviewSurface.offset = canvas.contentOffset
        let currentReviews = store.reviews.overlaysVisible && store.reviews.isBound(boardID: store.document.id, session: canvasSessionID) ? store.reviews.records + [store.reviews.draft].compactMap { $0 } : []
        reviewSurface.selectedID = store.reviews.selectedID
        reviewSurface.accessibilityValue = "visible=\(store.reviews.overlaysVisible); records=\(currentReviews.count); selected=\(store.reviews.selectedID?.uuidString.lowercased() ?? "none")"
        reviewSurface.records = currentReviews.map { ($0, store.reviews.rect(for: $0, items: store.document.items)) }

        insertionMarker.isHidden = store.insertionPoint == nil
        if let point = store.insertionPoint {
            insertionMarker.frame = CGRect(x: point.x * canvas.zoomScale - canvas.contentOffset.x - 16,
                                           y: point.y * canvas.zoomScale - canvas.contentOffset.y - 16, width: 32, height: 32)
        }
        updateLassoOverlay()
        synchronizeMergePlacement()
        synchronizeWritingAids()
        viewportOverlayMaxMS = max(viewportOverlayMaxMS, (CACurrentMediaTime() - overlaysStarted) * 1000)
        let textStarted = CACurrentMediaTime()
        synchronizeTextSelection()
        viewportTextSyncMaxMS = max(viewportTextSyncMaxMS, (CACurrentMediaTime() - textStarted) * 1000)
    }

    private func synchronizeMergePlacement() {
        let current = mergePlacement.flatMap { $0.canvasSessionID == canvasSessionID ? $0 : nil }
        mergePlacementOverlay.synchronize(session: current, zoom: canvas.zoomScale, offset: canvas.contentOffset)
    }

    private var textSelectionAvailable: Bool {
        ownsCurrentSession && allowsReadingTextSelection && window != nil && initialViewportApplied
            && !store.isBusy && !nativeInkInteractionActive
            && !store.reviewModeEnabled && !store.phoneMarkupEnabled && store.mode == .ink
            && store.insertionPoint == nil
            && (store.isPadReading || store.usesPhoneInterface || !(picker.selectedToolItem is PKToolPickerLassoItem))
    }

    private var textSelectionEnabled: Bool {
        textSelectionAvailable && (store.isPadReading || store.usesPhoneInterface
            || !store.childRoot.writingPriorityEnabled || writingTextSelectionRequested)
    }

    private var viewportNavigationEnabled: Bool {
        // A selected pen still permits direct-finger navigation. The shared
        // eligibility excludes ink in progress, lasso, reviews and placement.
        textSelectionAvailable
    }

    private var textSelectionGestureActive: Bool {
        let gestures: [UIGestureRecognizer?] = [canvas.drawingGestureRecognizer,
            canvas.panGestureRecognizer, canvas.pinchGestureRecognizer,
            readingOverlayPan, readingOverlayPinch, lassoViewportPinch]
        return lassoOverlay.isInteracting || gestures.contains {
            $0?.state == .began || $0?.state == .changed
        }
    }

    private var textSelectionKey: BoardTextSelectionSnapshotKey? {
        guard textSelectionEnabled else { return nil }
        var key = readingGeometryKey
        key?.prefersHighResolution = writingTextSelectionRequested
        return key
    }

    private var readingGeometryKey: BoardTextSelectionSnapshotKey? {
        guard textSelectionAvailable else { return nil }
        return BoardTextSelectionSnapshotKey(sessionID: canvasSessionID, boardID: store.document.id,
            size: bounds.size, offset: canvas.contentOffset, zoom: canvas.zoomScale,
            documentRevision: store.document.revision, updatedAt: store.document.updatedAt,
            previewEpoch: store.previewEpoch, imageRevision: store.imageRevision,
            renderedRevision: backdrop.renderedContentRevision, nativeInkRevision: nativeInkRevision)
    }

    private func synchronizeTextSelection() {
        let navigationEnabled = viewportNavigationEnabled
        if readingOverlayPan.isEnabled != navigationEnabled { readingOverlayPan.isEnabled = navigationEnabled }
        if readingOverlayPinch.isEnabled != navigationEnabled { readingOverlayPinch.isEnabled = navigationEnabled }
        let lassoPinching = lassoEnabled && (lassoViewportPinch.state == .began || lassoViewportPinch.state == .changed)
        // The ancestor owns ordinary finger navigation. A selected text range
        // retains its one-finger handles, while two-finger zoom remains available.
        let selectingText = textSelectionEnabled && inlineTextSelection?.hasSelection == true
        let panEnabled = !navigationEnabled && !lassoPinching && !selectingText
        if canvas.panGestureRecognizer.isEnabled != panEnabled { canvas.panGestureRecognizer.isEnabled = panEnabled }
        let pinchEnabled = !navigationEnabled && !lassoEnabled
        if canvas.pinchGestureRecognizer?.isEnabled != pinchEnabled { canvas.pinchGestureRecognizer?.isEnabled = pinchEnabled }
        inlineTextSelection?.update(textSelectionKey, idleDelay: store.isPadReading || store.usesPhoneInterface ? .milliseconds(450) : .seconds(2))
        synchronizeSpeechHighlight()
        updateCanvasAccessibilityValue()
    }

    private func updateCanvasAccessibilityValue() {
        // Invalidate cheaply. UIKit/XCTest/VoiceOver pull the current value only
        // when requested; a moving Pencil must not enumerate every old stroke.
        cachedAccessibilityValue = nil
    }

    private func nativeMemoryDiagnostic() -> String {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        let footprint = result == KERN_SUCCESS ? String(info.phys_footprint / 1_048_576) : "unavailable"
        return ";footprintMiB=\(footprint);availableMemoryMiB=\(UInt64(os_proc_available_memory()) / 1_048_576)"
    }

    private func canvasDiagnosticValue() -> String {
        if let cachedAccessibilityValue { return cachedAccessibilityValue }
        diagnosticBuilds += 1
        let center = viewportWorldCenter
        let tool = canvas.tool is PKInkingTool ? "ink" : canvas.tool is PKEraserTool ? "eraser" : canvas.tool is PKLassoTool ? "lasso" : "other"
        let colorState: String
        if let ink = canvas.tool as? PKInkingTool, let color = storedInk(ink) {
            colorState = ";inkType=\(ink.inkType.rawValue);inkRGBA=\(color.red),\(color.green),\(color.blue),\(color.alpha);inkWidth=\(ink.width)"
        } else { colorState = "" }
        let responderOwner = canvas.isFirstResponder ? "pencilKit" : isFirstResponder ? "appLassoHost" : "other"
        let undoBridgeMatches = capturedCanvasUndoManager.map { $0 === canvas.undoManager } ?? false
        let paperAppearance = ";hostStyle=\(traitCollection.userInterfaceStyle.rawValue);windowStyle=\(window?.traitCollection.userInterfaceStyle.rawValue ?? 0);canvasStyle=\(canvas.traitCollection.userInterfaceStyle.rawValue);pickerColorStyle=\(picker.colorUserInterfaceStyle.rawValue);firstResponder=\(canvas.isFirstResponder);responderOwner=\(responderOwner);lassoHostResponderPolicy=\(usesAppLassoResponder);undoBridgeCaptured=\(capturedCanvasUndoManager != nil);undoBridgeMatchesCanvas=\(undoBridgeMatches);undoBridgeCanUndo=\(boardUndoManager?.canUndo == true);undoBridgeCanRedo=\(boardUndoManager?.canRedo == true);nativeAXChildrenPolicy=\(canvas.usesAppOwnedLassoAccessibility);nativeAXChildrenBypasses=\(canvas.appOwnedAccessibilityBypasses);lassoOffWindowAttempts=\(lassoOffWindowAttempts);lassoOffWindowAssignments=\(lassoOffWindowAssignments);lassoOffWindowAssignmentUndoPreserved=\(lassoOffWindowAssignmentUndoPreserved);lassoOffWindowAssignmentRegistrationDisabled=\(lassoOffWindowAssignmentRegistrationDisabled);lassoOffWindowRestores=\(lassoOffWindowRestores);lassoOffWindowOutcome=\(lassoOffWindowOutcome);lassoOffWindowCameraPreserved=\(lassoOffWindowCameraPreserved);lassoOffWindowUndoPreserved=\(lassoOffWindowUndoPreserved);lassoOffWindowStructurePreserved=\(lassoOffWindowStructurePreserved);lassoOffWindowRegistrationPreserved=\(lassoOffWindowRegistrationPreserved)\(colorState)"
        let visibleWorldRect = CGRect(x: canvas.contentOffset.x / max(canvas.zoomScale, canvas.minimumZoomScale),
            y: canvas.contentOffset.y / max(canvas.zoomScale, canvas.minimumZoomScale),
            width: canvas.bounds.width / max(canvas.zoomScale, canvas.minimumZoomScale),
            height: canvas.bounds.height / max(canvas.zoomScale, canvas.minimumZoomScale))
        let canvasStrokes = canvas.drawing.strokes
        let inkDisplay = ";boardID=\(store.document.id.uuidString);sessionID=\(canvasSessionID.uuidString);embedded=\(isEmbeddedCanvas);canvasStrokes=\(canvasStrokes.count);storeStrokes=\(store.drawing.strokes.count);latestStrokeInViewport=\(canvasStrokes.last?.renderBounds.intersects(visibleWorldRect) == true);renderFinishes=\(nativeRenderingFinishes)"
        let performance = ";writingPriority=\(store.childRoot.writingPriorityEnabled);ocrRequested=\(writingTextSelectionRequested);diagnosticBuilds=\(diagnosticBuilds);visibilityScans=\(backdrop.visibilityScans);visibilityCacheHits=\(backdrop.visibilityCacheHits);inkCallbackMaxMS=\(inkCallbackMaxMS);viewportCallbackMaxMS=\(viewportCallbackMaxMS);pencilHitMaxMS=\(pencilHitMaxMS);pencilDispatchMaxMS=\(pencilDispatchMaxMS);viewportPaperPrepareMaxMS=\(viewportPaperPrepareMaxMS);viewportPaperDisplayMaxMS=\(viewportPaperDisplayMaxMS);viewportOverlayMaxMS=\(viewportOverlayMaxMS);viewportTextSyncMaxMS=\(viewportTextSyncMaxMS);backdropPrepareMaxMS=\(backdrop.prepareVisibleItemsMaxMS);backdropDrawMaxMS=\(backdrop.drawMaxMS);pdfLayerPages=\(backdrop.pdfLayerMetrics.pages);pdfLayerTiles=\(backdrop.pdfLayerMetrics.tiles)"
        let value = "\(inlineTextSelection?.currentStatus ?? "");viewport=\(center.x),\(center.y),\(canvas.zoomScale);revision=\(store.document.revision);drawingEnabled=\(canvas.isDrawingEnabled);drawingGestureEnabled=\(canvas.drawingGestureRecognizer.isEnabled);canvasInteractive=\(canvas.isUserInteractionEnabled);hostInteractive=\(isUserInteractionEnabled);busy=\(store.isBusy);reading=\(store.isPadReading);tool=\(tool);holdBegins=\(holdBegins);holdPreviews=\(holdPreviews);holdFinishes=\(holdFinishes);holdCommits=\(holdCommits);holdOutcome=\(holdOutcome);undoGroups=\(boardUndoManager?.groupingLevel ?? -1)\(paperAppearance)\(inkDisplay)\(performance);pickerItem=\(picker.selectedToolItem.identifier);pickerObserver=\(canvasObservesPicker);paletteOwner=\(ownsActivePalette);pencilBegins=\(pencilInputBegins);canvasPencilBegins=\(canvasPencilInputBegins);pencilEvents=\(pencilInputEvents);pencilTextRetirements=\(pencilTextRetirements);pencilRoutedHits=\(pencilRoutedHits);pencilTarget=\(lastPencilHitTarget);toolBegins=\(nativeToolBegins);toolEnds=\(nativeToolEnds);drawingChanges=\(nativeDrawingChanges);drawingApplications=\(nativeDrawingApplications);inkRevision=\(nativeInkRevision);backdropSyncs=\(backdropSynchronizations);navigationEnabled=\(viewportNavigationEnabled);textSelectionActive=\(inlineTextSelection?.hasSelection == true);nativePanEnabled=\(canvas.panGestureRecognizer.isEnabled);nativePanMinTouches=\(canvas.panGestureRecognizer.minimumNumberOfTouches);navigationPanBegins=\(navigationPanBegins);navigationPinchBegins=\(navigationPinchBegins)"
        let aidDiagnostics = ";aidMode=\(store.writingAids.mode.rawValue);aidOverlayMode=\(writingAidOverlay.mode.rawValue);aidTapeCount=\(store.writingAids.tapes?.tapes.count ?? 0);aidHasDraft=\(store.writingAids.hasTapeDraft);aidGestureBegins=\(writingAidOverlay.gestureBegins);aidGestureEnds=\(writingAidOverlay.gestureEnds);aidPointCount=\(writingAidOverlay.lastInputPointCount);aidClosureGap=\(writingAidOverlay.lastClosureGap);aidInputOutcome=\(writingAidOverlay.inputOutcome);aidCommitRequests=\(writingAidOverlay.drawingCommitRequests);aidCommitAttempts=\(aidCommitAttempts);aidCommits=\(aidCommits);aidCommitOutcome=\(aidCommitOutcome);aidLease=\(writingAidInputActive || pendingWritingAidCommit != nil)"
        let lassoSelectionDiagnostics = lassoSelection.map {
            ";lassoSelectedStrokes=\($0.strokeIndices.count);lassoSelectedItems=\($0.itemIDs.count);lassoBounds=\($0.bounds.minX),\($0.bounds.minY),\($0.bounds.width),\($0.bounds.height);lassoOutlinePoints=\($0.outline?.count ?? 0)"
        } ?? ";lassoSelectedStrokes=0;lassoSelectedItems=0;lassoBounds=none;lassoOutlinePoints=0"
        let lassoDiagnostics = nativeMemoryDiagnostic() + ";lassoEngine=\(isAppOwnedLassoSelected ? "custom" : usesNativeStrokeLasso ? "native" : "none");lassoInput=\(lassoInputDiagnostic);lassoClipboard=\(lassoClipboardDiagnostic)" + lassoSelectionDiagnostics
        cachedAccessibilityValue = value + aidDiagnostics + lassoDiagnostics
        return value + aidDiagnostics + lassoDiagnostics
    }

    private func synchronizeSpeechHighlight() {
        guard let source = speechHighlightKey, let rect = speechHighlightRect,
              let current = readingGeometryKey, source.hasSameDocument(as: current) else {
            speechHighlight.isHidden = true; return
        }
        // Toolbar status, rotation and safe-area changes can resize the canvas
        // after speech begins. Reproject through world coordinates so the yellow
        // mark follows the original text rather than the old screen rectangle.
        let normalized = current.normalizedRect(forWorldRect: source.worldRect(forNormalizedRect: rect))
        bringSubviewToFront(speechHighlight)
        speechHighlight.normalizedRect = normalized
        speechHighlight.isHidden = !normalized.intersects(CGRect(x: 0, y: 0, width: 1, height: 1))
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        if gestureRecognizer === lassoViewportPinch {
            return lassoEnabled && !lassoOverlay.isToolbarPoint(touch.location(in: lassoOverlay))
        }
        guard gestureRecognizer === readingOverlayPan || gestureRecognizer === readingOverlayPinch,
              viewportNavigationEnabled else { return false }
        let point = touch.location(in: self)
        // The writing palette shares this ancestor. Its taps, scrolling and
        // quick settings must never start a viewport drag.
        guard dockedPalette.isHidden || !dockedPalette.frame.contains(point),
              pencilArc.isHidden || !pencilArc.frame.contains(point),
              childOverlay?.hitTest(point, with: nil) == nil,
              videoOverlay.hitTest(point, with: nil) == nil,
              webOverlay.hitTest(point, with: nil) == nil else { return false }
        // A live selection owns its one-finger handles. Tapping outside dismisses
        // it; pinch remains available and clears stale screen-space selection.
        return gestureRecognizer === readingOverlayPinch || !inlineTextSelection.hasSelection
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === lassoViewportPinch { return lassoEnabled }
        guard gestureRecognizer === readingOverlayPan || gestureRecognizer === readingOverlayPinch else {
            return super.gestureRecognizerShouldBegin(gestureRecognizer)
        }
        return viewportNavigationEnabled && (gestureRecognizer === readingOverlayPinch || !inlineTextSelection.hasSelection)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        // A framework text interaction must not prevent an already moving
        // viewport. A stationary long press still owns its handles.
        return (lassoEnabled && gestureRecognizer === lassoViewportPinch) || viewportNavigationEnabled && (gestureRecognizer === readingOverlayPinch
            || (gestureRecognizer === readingOverlayPan && !inlineTextSelection.hasSelection))
    }

    @objc private func panReadingOverlay(_ recognizer: UIPanGestureRecognizer) {
        if [.ended, .cancelled, .failed].contains(recognizer.state) { updateWritingAidInteractionLease() }
        guard viewportNavigationEnabled else { return }
        switch recognizer.state {
        case .began:
            navigationPanBegins += 1
            updateCanvasAccessibilityValue()
            readingPanOffset = canvas.contentOffset
            store.externalInteractionActive = true
        case .changed:
            let delta = recognizer.translation(in: self)
            applyingViewport = true
            setClampedOffset(CGPoint(x: readingPanOffset.x - delta.x, y: readingPanOffset.y - delta.y))
            applyingViewport = false
            viewportDidChange(userInitiated: true)
        case .ended, .cancelled, .failed:
            updateWritingAidInteractionLease()
            backdrop.finishViewportInteraction()
            synchronizeTextSelection()
        default: break
        }
    }

    @objc private func pinchReadingOverlay(_ recognizer: UIPinchGestureRecognizer) {
        if [.ended, .cancelled, .failed].contains(recognizer.state) { updateWritingAidInteractionLease() }
        guard viewportNavigationEnabled else { return }
        let location = recognizer.location(in: self)
        switch recognizer.state {
        case .began:
            navigationPinchBegins += 1
            updateCanvasAccessibilityValue()
            readingPinchZoom = canvas.zoomScale
            readingPinchAnchor = worldPoint(location)
            store.externalInteractionActive = true
        case .changed:
            applyingViewport = true
            canvas.setZoomScale(min(canvas.maximumZoomScale, max(canvas.minimumZoomScale, readingPinchZoom * recognizer.scale)), animated: false)
            setClampedOffset(CGPoint(x: readingPinchAnchor.x * canvas.zoomScale - location.x,
                                    y: readingPinchAnchor.y * canvas.zoomScale - location.y))
            applyingViewport = false
            viewportDidChange(userInitiated: true)
        case .ended, .cancelled, .failed:
            updateWritingAidInteractionLease()
            backdrop.finishViewportInteraction()
            synchronizeTextSelection()
        default: break
        }
    }

    func beginReadAloud() {
        writingTextSelectionRequested = true
        guard let key = textSelectionKey,
              let image = inlineTextSelection.imageForReading(key: key) ?? boundedSnapshot(in: bounds, maximumDimension: 2600) else {
            store.status = String(localized: "请在阅读模式停稳白板后，再朗读当前画面。")
            return
        }
        store.readAloud.start(image: image, key: key, title: store.document.title)
    }

    func revealReadingText() -> String {
        guard textSelectionAvailable else { return String(localized: "请先结束批注、套索或回放，再停稳白板选择文字。") }
        writingTextSelectionRequested = true
        synchronizeTextSelection()
        return inlineTextSelection.revealText()
    }

    @objc private func revealAccessibleText() -> Bool {
        guard textSelectionAvailable else { return false }
        store.status = revealReadingText()
        return true
    }

    @objc private func copyAccessibleText() -> Bool { copyReadingText() }

    @discardableResult func copyReadingText() -> Bool {
        guard textSelectionEnabled else { return false }
        return inlineTextSelection.copySelection()
    }

    func configureEmbeddedViewport(center: CGPoint, zoom: CGFloat) {
        guard isEmbeddedCanvas else { return }
        // Parent-driven camera changes are display-only and must not dirty or
        // overwrite the child's own saved reading position.
        if abs(canvas.zoomScale - zoom) > 0.000001 || hypot(viewportWorldCenter.x - center.x, viewportWorldCenter.y - center.y) > 0.001 {
            setViewport(center: center, zoom: zoom)
        }
    }

    func activateInputPalette() {
        guard ownsCurrentSession, !store.isBusy, !store.isPadReading, !store.usesPhoneInterface, !store.reviewModeEnabled else { return }
        let ownershipChanged = Self.activePaletteHost !== self
        if let old = Self.activePaletteHost, old !== self {
            old.picker.setVisible(false, forFirstResponder: old.canvas)
            old.dockedPalette.isHidden = true
            old.canvas.resignFirstResponder()
            if old.isFirstResponder { old.resignFirstResponder() }
            if let interaction = old.pencilInteraction { old.removeInteraction(interaction); old.pencilInteraction = nil }
            old.pencilArc.isHidden = true
        }
        if !nativeInkInteractionActive, store.drawing != lastDrawing { applyDrawing(store.drawing) }
        Self.activePaletteHost = self
        // Repeated hit testing/tool-begin callbacks must not reconfigure the
        // responder or hidden native picker while PencilKit is starting ink.
        if ownershipChanged || !inputResponderIsFocused { showPalette() }
        else { enforcePickerDrawingPermissions(); updateCanvasAccessibilityValue() }
        // Each canvas retains its native selection. Activating its existing
        // picker may not emit a tool-change callback, so publish that selection
        // after ownership changes without treating it as an ink-attribute edit.
        if ownershipChanged { scheduleNativePenReflection(syncToolAttributes: false) }
    }

    /// Resolve app controls before Live Text's system overlay. Only a writable
    /// paper hit may retire that overlay; child canvases and media own their input.
    private func acceptsPencilOnPaper(at point: CGPoint, with event: UIEvent?) -> Bool {
        guard ownsCurrentSession, isUserInteractionEnabled, !store.isBusy,
              store.canEditBoardContents, store.mode == .ink, store.insertionPoint == nil,
              !(picker.selectedToolItem is PKToolPickerLassoItem),
              canvas.tool is PKInkingTool || canvas.tool is PKEraserTool,
              initialViewportApplied, canvas.frame.contains(point) else { return false }
        let controls: [UIView?] = [dockedPalette, pencilArc, lassoOverlay,
            childOverlay, videoOverlay, webOverlay, reviewSurface, interactionSurface, writingAidOverlay]
        return !controls.compactMap { $0 }.contains { control in
            control.hitTest(control.convert(point, from: self), with: event) != nil
        }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let started = CACurrentMediaTime()
        defer { pencilHitMaxMS = max(pencilHitMaxMS, (CACurrentMediaTime() - started) * 1000) }
        let pencil = event?.allTouches?.first {
            $0.type == .pencil && $0.phase != .ended && $0.phase != .cancelled
                && abs($0.location(in: self).x - point.x) <= 1
                && abs($0.location(in: self).y - point.y) <= 1
        }
        let pencilOnPaper = pencil != nil && acceptsPencilOnPaper(at: point, with: event)
        if pencilOnPaper {
            // The old order queried the overlay first and only cleared it if
            // it had already let the Pencil through. Invalidate before UIKit
            // chooses a target, including any in-flight analyzer completion.
            if inlineTextSelection?.hasInstalledAnalysis == true { pencilTextRetirements += 1 }
            writingTextSelectionRequested = false
            inlineTextSelection?.update(nil, idleDelay: .seconds(2))
            if !ownsActivePalette || !canvas.isFirstResponder || !canvas.isDrawingEnabled
                || !canvas.drawingGestureRecognizer.isEnabled { activateInputPalette() }
        }
        var hit = super.hitTest(point, with: event)
        if pencilOnPaper, !(hit === canvas || hit?.isDescendant(of: canvas) == true),
           let paperHit = canvas.hitTest(canvas.convert(point, from: self), with: event) {
            // UIKit may remove the analysis overlay on a later layout turn.
            // Public canvas hit-testing gives this same Pencil its native target.
            hit = paperHit
            pencilRoutedHits += 1
        }
        if let pencil,
           pencil.timestamp != lastPencilInputTimestamp {
            lastPencilInputTimestamp = pencil.timestamp
            pencilInputEvents += 1
            if pencilOnPaper {
                pencilDispatchMaxMS = max(pencilDispatchMaxMS,
                    max(0, ProcessInfo.processInfo.systemUptime - pencil.timestamp) * 1000)
            }
            let canvasHit = hit === canvas || hit?.isDescendant(of: canvas) == true
            if pencil.phase == .began {
                pencilInputBegins += 1
                if canvasHit { canvasPencilInputBegins += 1 }
            }
            lastPencilHitTarget = hit.map { String(describing: type(of: $0)) } ?? "none"
            updateCanvasAccessibilityValue()
        }
        if !pencilOnPaper, let hit, (hit === canvas || hit.isDescendant(of: canvas)),
           event?.allTouches?.contains(where: { $0.phase == .began }) == true { activateInputPalette() }
        return hit
    }

    private func showPalette() {
        if isEmbeddedCanvas && Self.activePaletteHost !== self { return }
        if !isEmbeddedCanvas, let active = Self.activePaletteHost, active !== self,
           active.window != nil, active.store.childRoot === store.childRoot { return }
        guard ownsCurrentSession, !store.isBusy, !store.isPadReading, !store.reviewModeEnabled, !store.usesPhoneInterface, window != nil, store.mode == .ink else { return }
        Self.activePaletteHost = self
        paletteDockSettings = .load()
        synchronizePickerCanvasOwnership()
        let visible = paletteDockSettings.usesSystemPalette && !paletteDockSettings.isMinimized
        if picker.isVisible != visible { picker.setVisible(visible, forFirstResponder: canvas) }
        synchronizeInputResponder()
        restoreCustomEraserSettings()
        enforcePickerDrawingPermissions()
        synchronizeDockedPalette()
    }

    private func applyPhoneInputPolicy() {
        guard store.usesPhoneInterface else { return }
        if canvas.drawingPolicy != .pencilOnly { canvas.drawingPolicy = .pencilOnly }
        if canvas.isDrawingEnabled { canvas.isDrawingEnabled = false }
        if canvas.panGestureRecognizer.minimumNumberOfTouches != 1 { canvas.panGestureRecognizer.minimumNumberOfTouches = 1 }
        scheduleResponderPolicy()
        canvas.accessibilityLabel = String(localized: "阅读画布")
        canvas.accessibilityHint = String(localized: "单指平移，双指缩放；长按文字选择并复制，阅读模式不会添加笔迹。")
    }

    // MARK: - User-defined native pen tools

    private static let savedPenPrefix = "inkspace.savedPen."
    private static let pickerStateKey = "InkSpace.nativePickerState.v2"

    private struct StoredInk: Codable {
        var red: Double
        var green: Double
        var blue: Double
        var alpha: Double
        var width: Double

        var color: UIColor {
            UIColor(red: CGFloat(Self.component(red)), green: CGFloat(Self.component(green)),
                    blue: CGFloat(Self.component(blue)), alpha: CGFloat(Self.component(alpha, fallback: 1)))
        }

        private static func component(_ value: Double, fallback: Double = 0) -> Double {
            value.isFinite ? min(1, max(0, value)) : fallback
        }
    }

    private struct StoredPickerState: Codable {
        var ink: [String: StoredInk]
        var selectedIdentifier: String
        var rulerActive: Bool
    }

    private static func loadPickerState() -> StoredPickerState? {
        guard let data = UserDefaults.standard.data(forKey: pickerStateKey)
            ?? UserDefaults.standard.data(forKey: SavedPenSettings.legacyPickerKey) else { return nil }
        return try? JSONDecoder().decode(StoredPickerState.self, from: data)
    }

    private static let emptyPaletteIdentifier = "inkspace.palette.empty"
    private static let writingAidIdentifier = "inkspace.palette.writingAids"

    private var paletteConfigurationChanged: Bool {
        installedPens != store.savedPens || installedPaletteEntries != store.nativePaletteEntries
    }

    private func enforcePickerDrawingPermissions() {
        if store.usesPhoneInterface { applyPhoneInputPolicy(); return }
        let allowsInk = store.mode == .ink && !store.isPadReading && !store.reviewModeEnabled && !store.isBusy
        if !allowsInk, heldLineStroke != nil { cancelPencilStraightening() }
        if canvas.drawingPolicy != .pencilOnly { canvas.drawingPolicy = .pencilOnly }
        let gestureEnabled = allowsInk && !lassoEnabled && !writingAidOverlay.capturesPencil
        if canvas.drawingGestureRecognizer.isEnabled != gestureEnabled { canvas.drawingGestureRecognizer.isEnabled = gestureEnabled }
        let drawingEnabled = gestureEnabled && picker.selectedToolItem.identifier != Self.emptyPaletteIdentifier
            && picker.selectedToolItem.identifier != Self.writingAidIdentifier
        if canvas.isDrawingEnabled != drawingEnabled { canvas.isDrawingEnabled = drawingEnabled }
    }

    /// Only the visible native palette may mutate the canvas through PencilKit's
    /// observer. The docked palette owns tools and input permissions explicitly.
    private func synchronizePickerCanvasOwnership() {
        canvas.usesAppOwnedLassoAccessibility = !store.usesPhoneInterface
            && !paletteDockSettings.usesSystemPalette && isAppOwnedLassoSelected
        let observes = !store.usesPhoneInterface && paletteDockSettings.usesSystemPalette && !isAppOwnedLassoSelected
        guard canvasObservesPicker != observes else {
            if !observes, !store.usesPhoneInterface, !nativeInkInteractionActive { reconcileDockedPickerTool() }
            return
        }
        if observes { picker.addObserver(canvas) }
        else { picker.removeObserver(canvas) }
        canvasObservesPicker = observes
        if !observes, !store.usesPhoneInterface { reconcileDockedPickerTool() }
    }

    private func reconcileDockedPickerTool() {
        guard !canvasObservesPicker, !nativeInkInteractionActive else { return }
        let item = picker.selectedToolItem
        if let ink = item as? PKToolPickerInkingItem {
            if (canvas.tool as? PKInkingTool) != ink.inkingTool { canvas.tool = ink.inkingTool }
        } else if let eraser = item as? PKToolPickerEraserItem {
            let tool = BoardPaletteEraserSettings.load(fallback: eraser.eraserTool).tool
            if (canvas.tool as? PKEraserTool) != tool { canvas.tool = tool }
        } else if let lasso = item as? PKToolPickerLassoItem {
            if isAppOwnedLassoSelected {
                if (canvas.tool as? PKInkingTool) != customLassoIdleTool { canvas.tool = customLassoIdleTool }
            } else if (canvas.tool as? PKLassoTool) != lasso.lassoTool { canvas.tool = lasso.lassoTool }
        }
        if canvas.isRulerActive != picker.isRulerActive { canvas.isRulerActive = picker.isRulerActive }
        enforcePickerDrawingPermissions()
    }

    private var ownsActivePalette: Bool {
        Self.activePaletteHost === self || (Self.activePaletteHost == nil && !isEmbeddedCanvas)
    }

    private func configureDockedPalette() {
        pencilArc.isHidden = true
        addSubview(pencilArc)
        pencilArc.onClose = { [weak self] in self?.pencilArc.isHidden = true }
        pencilArc.onSelect = { [weak self] identifier in self?.selectDockedTool(identifier) }
        pencilArc.onEditTool = { [weak self] identifier in self?.showPaletteQuickSettings(identifier); self?.pencilArc.isHidden = true }
        pencilArc.onEdit = { [weak self] in
            guard let self, let entry = self.store.nativePaletteEntries.first(where: { self.pickerItem(for: $0)?.identifier == self.picker.selectedToolItemIdentifier }) else { return }
            self.showPaletteQuickSettings(entry.id); self.pencilArc.isHidden = true
        }
        pencilArc.onManage = { [weak self] in self?.store.requestNativePaletteEditor(); self?.pencilArc.isHidden = true }
        dockedPalette.onShowArc = { [weak self] in self?.togglePencilArc(at: nil) }
        dockedPalette.onEdit = { [weak self] identifier in self?.showPaletteQuickSettings(identifier) }
        dockedPalette.onManage = { [weak self] in
            guard let self, self.ownsCurrentSession, !self.store.isBusy else { return }
            self.store.requestNativePaletteEditor()
        }
        dockedPalette.onSettings = { [weak self] settings in
            guard let self, self.ownsCurrentSession, !self.store.isBusy else { return }
            self.paletteDockSettings = settings
            settings.save()
            self.showPalette()
        }
        dockedPalette.onSelect = { [weak self] identifier in self?.selectDockedTool(identifier) }
    }

    private func showPaletteQuickSettings(_ identifier: String) {
        guard ownsCurrentSession, !store.isBusy, !store.isPadReading, !store.reviewModeEnabled,
              let entry = store.nativePaletteEntries.first(where: { $0.id == identifier }) else { return }
        let controller: UIViewController
        switch entry {
        case .pen(let id):
            guard let pen = store.savedPens.first(where: { $0.id == id }) else { return }
            controller = BoardPaletteQuickSettingsController.pen(pen) { [weak self] updated in
                guard let self, self.ownsCurrentSession, updated.id == id else { return false }
                return self.store.saveSavedPen(updated)
            }
        case .eraser:
            guard let native = pickerItem(for: .eraser) as? PKToolPickerEraserItem else { return }
            let settings = BoardPaletteEraserSettings.load(fallback: native.eraserTool)
            controller = BoardPaletteQuickSettingsController.eraser(settings) { [weak self] updated in
                guard let self, self.ownsCurrentSession, !self.store.isBusy else { return }
                updated.save()
                if self.picker.selectedToolItem is PKToolPickerEraserItem {
                    self.canvas.tool = updated.tool
                    self.enforcePickerDrawingPermissions()
                }
            }
        case .lasso:
            controller = BoardPaletteQuickSettingsController.lasso(lassoTypes) { [weak self] types in
                guard let self, self.ownsCurrentSession, !self.store.isBusy else { return }
                self.lassoOverlay.onTypesChanged?(types)
            }
        case .ruler:
            controller = BoardPaletteQuickSettingsController.ruler(picker.isRulerActive) { [weak self] active in
                guard let self, self.ownsCurrentSession, !self.store.isBusy else { return }
                self.picker.isRulerActive = active
                self.schedulePickerPersistence(); self.synchronizeDockedPalette()
            }
        }
        dockedPalette.presentQuickSettings(controller, for: identifier)
    }


    private var canHandlePencil: Bool {
        ownsCurrentSession && ownsActivePalette && window != nil && inputResponderIsFocused
            && !store.usesPhoneInterface && !store.isPadReading && !store.reviewModeEnabled
            && !store.isBusy && !store.externalInteractionActive && store.mode == .ink
            && !isUsingDrawingTool && !paletteDockSettings.usesSystemPalette
    }

    private func synchronizePencilInteraction() {
        let enabled = ownsCurrentSession && ownsActivePalette && window != nil
            && !store.usesPhoneInterface && !store.isPadReading && !store.reviewModeEnabled
            && !store.isBusy && store.mode == .ink && !paletteDockSettings.usesSystemPalette
        if enabled {
            if pencilInteraction == nil {
                let interaction = UIPencilInteraction(delegate: self)
                addInteraction(interaction); pencilInteraction = interaction
            }
        } else {
            if let pencilInteraction { removeInteraction(pencilInteraction); self.pencilInteraction = nil }
            pencilArc.isHidden = true
        }
    }

    private func restoreCustomEraserSettings() {
        guard !paletteDockSettings.usesSystemPalette, !isUsingDrawingTool,
              let eraser = picker.selectedToolItem as? PKToolPickerEraserItem else { return }
        let saved = BoardPaletteEraserSettings.load(fallback: eraser.eraserTool).tool
        if let current = canvas.tool as? PKEraserTool,
           current.eraserType == saved.eraserType, current.width == saved.width { return }
        canvas.tool = saved
        enforcePickerDrawingPermissions()
    }

    private func applySelectedPickerTool() {
        let item = picker.selectedToolItem
        if !(item is PKToolPickerLassoItem) { usesNativeStrokeLasso = false }
        synchronizePickerCanvasOwnership()
        if let ink = item as? PKToolPickerInkingItem { canvas.tool = ink.inkingTool }
        else if let eraser = item as? PKToolPickerEraserItem {
            canvas.tool = paletteDockSettings.usesSystemPalette ? eraser.eraserTool : BoardPaletteEraserSettings.load(fallback: eraser.eraserTool).tool
        }
        else if let lasso = item as? PKToolPickerLassoItem {
            if isAppOwnedLassoSelected {
                if (canvas.tool as? PKInkingTool) != customLassoIdleTool { canvas.tool = customLassoIdleTool }
            } else { canvas.tool = lasso.lassoTool }
        }
        if item.identifier != Self.writingAidIdentifier, !(item is PKToolPickerEraserItem) { lastNonEraserItemIdentifier = item.identifier }
        enforcePickerDrawingPermissions()
        synchronizeLasso()
    }

    private func selectDockedTool(_ identifier: String) {
        if identifier == Self.writingAidIdentifier {
            guard ownsCurrentSession, store.canEditBoardContents, !store.isBusy else { return }
            presentWritingAidSettings(); return
        }
        guard ownsCurrentSession, !store.isBusy, !store.isPadReading, !store.reviewModeEnabled,
              let entry = store.nativePaletteEntries.first(where: { $0.id == identifier || pickerItem(for: $0)?.identifier == identifier }),
              let item = pickerItem(for: entry) else { return }
        if store.writingAids.mode != .off { store.writingAids.mode = .off; synchronizeWritingAids() }
        if entry == .lasso { usesNativeStrokeLasso = false }
        if entry == .ruler {
            picker.isRulerActive.toggle(); schedulePickerPersistence()
        } else {
            if picker.selectedToolItemIdentifier != item.identifier { previousPencilItemIdentifier = picker.selectedToolItemIdentifier }
            picker.selectedToolItemIdentifier = item.identifier
            applySelectedPickerTool()
            scheduleNativePenReflection(syncToolAttributes: false)
        }
        synchronizeInputResponder(); synchronizeDockedPalette()
    }

    private func editCurrentPencil() {
        let id = store.savedPens.first { $0.toolIdentifier == picker.selectedToolItemIdentifier }?.id
            ?? lastNonEraserItemIdentifier.flatMap { identifier in store.savedPens.first { $0.toolIdentifier == identifier }?.id }
        if let id { store.requestSavedPenEditor(id) } else { store.requestNativePaletteEditor() }
    }

    private func togglePencilArc(at point: CGPoint?) {
        guard canHandlePencil else { return }
        if !pencilArc.isHidden { pencilArc.isHidden = true; return }
        let area = bounds.inset(by: safeAreaInsets).insetBy(dx: 8, dy: 8)
        guard area.width >= 160, area.height >= 112 else { return }
        let size = CGSize(width: min(282, area.width), height: min(188, area.height))
        let anchor = point ?? CGPoint(x: area.midX, y: area.midY)
        pencilArc.frame = CGRect(x: min(max(area.minX, anchor.x-size.width/2), area.maxX-size.width),
            y: min(max(area.minY, anchor.y-size.height), area.maxY-size.height), width: size.width, height: size.height)
        pencilArc.update(pencilArcItems); pencilArc.isHidden = false; bringSubviewToFront(pencilArc)
    }

    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        guard interaction === pencilInteraction, canHandlePencil else { return }
        pencilTapCount += 1
        performPencilAction(BoardPencilGestureSettings.load().doubleTap, system: UIPencilInteraction.preferredTapAction, point: tap.hoverPose?.location)
    }

    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        guard interaction === pencilInteraction, canHandlePencil, squeeze.phase == .ended else { return }
        pencilSqueezeCount += 1
        performPencilAction(BoardPencilGestureSettings.load().squeeze, system: UIPencilInteraction.preferredSqueezeAction, point: squeeze.hoverPose?.location)
    }

    private var returnPencilItemIdentifier: String? {
        let candidates = store.nativePaletteEntries.compactMap { pickerItem(for: $0) }
            .filter { $0 is PKToolPickerInkingItem || $0 is PKToolPickerLassoItem }
        if let lastNonEraserItemIdentifier, candidates.contains(where: { $0.identifier == lastNonEraserItemIdentifier }) { return lastNonEraserItemIdentifier }
        return (candidates.first { $0 is PKToolPickerInkingItem } ?? candidates.first)?.identifier
    }

    private func performPencilAction(_ preference: BoardPencilGestureSettings.Action, system: UIPencilPreferredAction, point: CGPoint?) {
        let action: BoardPencilGestureSettings.Action
        if preference == .system {
            switch system {
            case .switchEraser: action = .eraser
            case .switchPrevious: action = .previous
            case .showColorPalette, .showInkAttributes: action = .attributes
            case .showContextualPalette: action = .palette
            case .ignore, .runSystemShortcut: action = .none
            @unknown default: action = .none
            }
        } else { action = preference }
        switch action {
        case .eraser:
            if canvas.tool is PKEraserTool {
                if let identifier = returnPencilItemIdentifier {
                    selectDockedTool(identifier)
                }
            } else {
                lastNonEraserItemIdentifier = picker.selectedToolItemIdentifier
                if let eraser = store.nativePaletteEntries.first(where: { $0 == .eraser }) { selectDockedTool(eraser.id) }
                else { canvas.tool = PKEraserTool(.bitmap) }
            }
        case .previous:
            if let identifier = previousPencilItemIdentifier { selectDockedTool(identifier) }
        case .palette: togglePencilArc(at: point)
        case .attributes: pencilArc.isHidden = true; editCurrentPencil()
        case .none, .system: break
        }
        synchronizeDockedPalette()
    }

    private func pickerItem(for entry: NativePaletteEntry) -> PKToolPickerItem? {
        picker.toolItems.first { item in
            switch entry {
            case .pen: item.identifier == entry.id
            case .eraser: item is PKToolPickerEraserItem
            case .lasso: item is PKToolPickerLassoItem
            case .ruler: item is PKToolPickerRulerItem
            }
        }
    }

    private func synchronizeDockedPalette() {
        dockedPalette.isHidden = !ownsCurrentSession || !ownsActivePalette || store.usesPhoneInterface
            || store.isPadReading || store.reviewModeEnabled || store.mode != .ink || window == nil
        synchronizePencilInteraction()
        guard !dockedPalette.isHidden else { return }
        var items: [BoardDockedPaletteView.Item] = store.nativePaletteEntries.compactMap { entry in
            guard let item = pickerItem(for: entry) else { return nil }
            let title: String
            let symbol: String
            var color = UIColor.label
            switch entry {
            case .pen(let id):
                guard let pen = store.savedPens.first(where: { $0.id == id }) else { return nil }
                title = pen.name
                symbol = pen.kind == .marker ? "highlighter" : pen.kind == .pencil ? "pencil" : "pencil.tip"
                color = UIColor(red: pen.red, green: pen.green, blue: pen.blue, alpha: max(0.4, pen.alpha))
            case .eraser: title = String(localized: "橡皮擦"); symbol = "eraser"
            case .lasso: title = String(localized: "套索"); symbol = "lasso"
            case .ruler: title = String(localized: "直尺"); symbol = "ruler"
            }
            return BoardDockedPaletteView.Item(id: entry.id, title: title, symbol: symbol, color: color,
                selected: entry == .ruler ? picker.isRulerActive : picker.selectedToolItem.identifier == item.identifier)
        }
        items.append(BoardDockedPaletteView.Item(id: Self.writingAidIdentifier,
            title: store.writingAids.mode == .off ? String(localized: "辅助笔") : store.writingAids.mode.title,
            symbol: "wand.and.stars", color: .systemTeal, selected: store.writingAids.mode != .off))
        pencilArcItems = items
        if lastDockedPaletteSettings != paletteDockSettings || lastDockedPaletteItems != items {
            lastDockedPaletteSettings = paletteDockSettings
            lastDockedPaletteItems = items
            dockedPalette.update(settings: paletteDockSettings, items: items)
        }
        dockedPalette.accessibilityValue = "edge=\(paletteDockSettings.edge.rawValue);minimized=\(paletteDockSettings.isMinimized);system=\(paletteDockSettings.usesSystemPalette); pencilTaps=\(pencilTapCount); pencilSqueezes=\(pencilSqueezeCount); eraser=\(canvas.tool is PKEraserTool)"
        layoutDockedPalette()
        bringSubviewToFront(dockedPalette)
        if !pencilArc.isHidden { pencilArc.update(items); bringSubviewToFront(pencilArc) }
    }

    private func layoutDockedPalette() {
        if !pencilArc.isHidden {
            let area = bounds.inset(by: safeAreaInsets).insetBy(dx: 8, dy: 8)
            if area.width < 160 || area.height < 112 { pencilArc.isHidden = true }
            else {
                let size = CGSize(width: min(282, area.width), height: min(188, area.height))
                pencilArc.frame = CGRect(x: min(max(area.minX, pencilArc.frame.minX), area.maxX-size.width),
                    y: min(max(area.minY, pencilArc.frame.minY), area.maxY-size.height), width: size.width, height: size.height)
            }
        }
        dockedPalette.frame = paletteDockSettings.frame(in: bounds.inset(by: safeAreaInsets), toolCount: store.nativePaletteEntries.count + 1)
    }

    private func configurePaletteAccessory() {
        // Commands belong to the native floating picker, not a second pen strip.
        let action = UIAction(title: String(localized: "管理笔栏")) { [weak self] _ in
            guard let self, self.ownsCurrentSession, !self.store.isBusy else { return }
            self.store.requestNativePaletteEditor()
        }
        let item = UIBarButtonItem(image: UIImage(systemName: "plus"), primaryAction: action)
        item.accessibilityLabel = String(localized: "添加与编辑工具")
        item.accessibilityIdentifier = "nativePalette.manage"
        picker.accessoryItem = item
    }

    private static func paletteItems(pens: [SavedPen], entries: [NativePaletteEntry], reusing oldItems: [PKToolPickerItem], store: BoardStore) -> [PKToolPickerItem] {
        let inks = savedPenItems(pens)
        var items: [PKToolPickerItem] = entries.compactMap { entry in
            switch entry {
            case .pen(let id): return inks.first { $0.identifier == savedPenPrefix + id.uuidString }
            case .eraser: return oldItems.first { $0 is PKToolPickerEraserItem } ?? PKToolPickerEraserItem(type: .bitmap)
            case .lasso: return oldItems.first { $0 is PKToolPickerLassoItem } ?? PKToolPickerLassoItem()
            case .ruler: return oldItems.first { $0 is PKToolPickerRulerItem } ?? PKToolPickerRulerItem()
            }
        }
        // PencilKit requires a nonempty picker. An inert management item preserves
        // the user's intentionally empty/ ruler-only palette without reviving a
        // deleted pen or silently allowing ink with a tool that is no longer shown.
        if !items.contains(where: { $0 is PKToolPickerInkingItem || $0 is PKToolPickerEraserItem || $0 is PKToolPickerLassoItem }) {
            var configuration = PKToolPickerCustomItem.Configuration(identifier: emptyPaletteIdentifier, name: String(localized: "添加工具"))
            configuration.allowsColorSelection = false
            configuration.toolAttributeControls = []
            configuration.imageProvider = { _ in
                let renderer = UIGraphicsImageRenderer(size: CGSize(width: 30, height: 150))
                return renderer.image { _ in
                    UIImage(systemName: "plus.circle.fill")?.withTintColor(.systemTeal, renderingMode: .alwaysOriginal)
                        .draw(in: CGRect(x: 1, y: 5, width: 28, height: 28))
                }
            }
            configuration.viewControllerProvider = { _ in
                let controller = UIViewController()
                let button = UIButton(type: .system)
                button.setTitle(String(localized: "添加与编辑工具"), for: .normal)
                button.addAction(UIAction { _ in store.requestNativePaletteEditor() }, for: .touchUpInside)
                button.accessibilityIdentifier = "nativePalette.emptyManage"
                controller.view = button
                controller.preferredContentSize = CGSize(width: 240, height: 60)
                return controller
            }
            items.append(PKToolPickerCustomItem(configuration: configuration))
        }
        var aidConfiguration = PKToolPickerCustomItem.Configuration(identifier: writingAidIdentifier, name: String(localized: "辅助笔"))
        aidConfiguration.allowsColorSelection = false
        aidConfiguration.toolAttributeControls = []
        aidConfiguration.imageProvider = { _ in
            UIGraphicsImageRenderer(size: CGSize(width: 30, height: 150)).image { _ in
                UIImage(systemName: "wand.and.stars")?.withTintColor(.systemTeal, renderingMode: .alwaysOriginal)
                    .draw(in: CGRect(x: 1, y: 5, width: 28, height: 28))
            }
        }
        aidConfiguration.viewControllerProvider = { _ in
            let controller = UIHostingController(rootView: NavigationStack {
                BoardWritingAidSettingsView(controller: store.writingAids, canEdit: store.canEditBoardContents)
            })
            controller.preferredContentSize = CGSize(width: 360, height: 480)
            return controller
        }
        items.append(PKToolPickerCustomItem(configuration: aidConfiguration))
        return items
    }

    private static func savedPenItems(_ pens: [SavedPen]) -> [PKToolPickerItem] {
        var seen = Set<String>()
        return pens.compactMap { pen -> PKToolPickerItem? in
            // A duplicate identifier would silently drop a later PKToolPicker item.
            guard seen.insert(pen.toolIdentifier).inserted else { return nil }
            let color = StoredInk(red: pen.red, green: pen.green, blue: pen.blue, alpha: pen.alpha, width: pen.width).color
            let width = pen.width.isFinite ? pen.width : pen.kind.defaultWidth
            return PKToolPickerInkingItem(type: pen.kind.inkType, color: color,
                                          width: CGFloat(min(pen.kind.maximumWidth, max(pen.kind.minimumWidth, width))),
                                          identifier: pen.toolIdentifier)
        }
    }

    private var pendingPenSelection: SavedPenSelectionRequest? {
        guard let request = store.savedPenSelectionRequest,
              request.id != lastAppliedPenSelectionRequestID else { return nil }
        return request
    }

    private func schedulePickerRefresh() {
        guard !pickerRefreshQueued, ownsCurrentSession else { return }
        pickerRefreshQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self, self.ownsCurrentSession else { return }
            self.pickerRefreshQueued = false
            // Swapping palettes while a Pencil stroke is active could interrupt it.
            // A cancelled gesture may omit the tool-end delegate callback. Reconcile
            // its latch with the public recognizer, whose idle state is .possible.
            let drawingState = self.canvas.drawingGestureRecognizer.state
            if self.isUsingDrawingTool, drawingState != .began, drawingState != .changed {
                self.isUsingDrawingTool = false
            }
            // Tool-end and gesture-terminal callbacks retry deferred selections.
            guard !self.store.isBusy, !self.isUsingDrawingTool,
                  drawingState != .began, drawingState != .changed else { return }
            self.rebuildPickerIfNeeded()
            if let selection = self.pendingPenSelection {
                self.lastAppliedPenSelectionRequestID = selection.id
                self.selectInstalledPen(selection.penID)
            }
        }
    }

    private func rebuildPickerIfNeeded() {
        guard ownsCurrentSession, paletteConfigurationChanged else { return }
        let oldPicker = picker
        let wasVisible = oldPicker.isVisible
        let selectedIdentifier = oldPicker.selectedToolItemIdentifier
        let rulerActive = oldPicker.isRulerActive
        persistPickerState()
        // Every ink tool follows the user's order; no fixed ink tools reappear.
        // Keep the existing utility objects to preserve eraser/ruler settings.
        let utilities = oldPicker.toolItems.filter { !($0 is PKToolPickerInkingItem) } + retainedUtilityItems
        let nextItems = Self.paletteItems(pens: store.savedPens, entries: store.nativePaletteEntries, reusing: utilities, store: store)
        let nextPicker = PKToolPicker(toolItems: nextItems)
        nextPicker.colorUserInterfaceStyle = .light
        nextPicker.stateAutosaveName = nil
        nextPicker.showsDrawingPolicyControls = false
        nextPicker.isRulerActive = store.nativePaletteEntries.contains(.ruler) && rulerActive
        let requestedIdentifier = store.selectedSavedPenID
            .flatMap { id in store.savedPens.first(where: { $0.id == id })?.toolIdentifier }
        let nextIdentifier = store.writingAids.mode == .off ? (requestedIdentifier ?? selectedIdentifier) : Self.writingAidIdentifier
        nextPicker.selectedToolItemIdentifier = nextItems.first(where: { $0.identifier == nextIdentifier })?.identifier
            ?? nextItems.first(where: { !($0 is PKToolPickerRulerItem) })!.identifier
        isReconfiguringPicker = true
        // Never associate two visible pickers with the same first responder.
        oldPicker.setVisible(false, forFirstResponder: canvas)
        if canvasObservesPicker { oldPicker.removeObserver(canvas) }
        canvasObservesPicker = false
        oldPicker.removeObserver(self)
        picker = nextPicker
        configurePaletteAccessory()
        installedPens = store.savedPens
        installedPaletteEntries = store.nativePaletteEntries
        // Keep settings of hidden utilities for restoring them during this session.
        var retainedIdentifiers = Set<String>()
        retainedUtilityItems = utilities.filter { item in
            (item is PKToolPickerEraserItem || item is PKToolPickerLassoItem || item is PKToolPickerRulerItem) && retainedIdentifiers.insert(item.identifier).inserted
        }
        for item in nextItems where !(item is PKToolPickerInkingItem) {
            if !retainedUtilityItems.contains(where: { $0.identifier == item.identifier }) { retainedUtilityItems.append(item) }
        }
        picker.addObserver(self)
        synchronizePickerCanvasOwnership()
        enforcePickerDrawingPermissions()
        if wasVisible, paletteDockSettings.usesSystemPalette, !paletteDockSettings.isMinimized, store.mode == .ink, !store.isPadReading, !store.reviewModeEnabled, window != nil {
            picker.setVisible(true, forFirstResponder: canvas)
        }
        isReconfiguringPicker = false
        // No drawing assignment, responder replacement, or undo reset occurs here.
        scheduleNativePenReflection(syncToolAttributes: false)
        synchronizeDockedPalette()
    }

    private func selectInstalledPen(_ id: UUID) {
        guard ownsCurrentSession, let pen = store.savedPens.first(where: { $0.id == id }),
              picker.toolItems.contains(where: { $0.identifier == pen.toolIdentifier }) else { return }
        if store.writingAids.mode != .off { store.writingAids.mode = .off; synchronizeWritingAids() }
        isReconfiguringPicker = true
        picker.selectedToolItemIdentifier = pen.toolIdentifier
        isReconfiguringPicker = false
        showPalette()
        scheduleNativePenReflection(syncToolAttributes: false)
    }

    func toolPickerSelectedToolItemDidChange(_ toolPicker: PKToolPicker) {
        guard ownsCurrentSession, !isReconfiguringPicker, toolPicker === picker else { return }
        // Retire the canvas observer immediately when custom lasso owns input.
        // Attribute persistence remains coalesced to the next run-loop turn.
        synchronizePickerCanvasOwnership()
        if picker.selectedToolItem.identifier != Self.writingAidIdentifier, store.writingAids.mode != .off {
            store.writingAids.mode = .off; synchronizeWritingAids()
        }
        scheduleNativePenReflection()
    }

    func toolPickerIsRulerActiveDidChange(_ toolPicker: PKToolPicker) {
        guard ownsCurrentSession, !isReconfiguringPicker, toolPicker === picker else { return }
        schedulePickerPersistence()
        reconcileDockedPickerTool()
        synchronizeDockedPalette()
    }

    private func scheduleNativePenReflection(syncToolAttributes: Bool = true) {
        guard ownsCurrentSession, !store.usesPhoneInterface else { return }
        // PencilKit may notify synchronously during updateUIView/first-responder
        // changes. Coalesce notifications and read the latest item next run loop.
        nativePenReflectionRevision += 1
        let revision = nativePenReflectionRevision
        let currentPicker = picker
        DispatchQueue.main.async { [weak self, weak currentPicker] in
            guard let self, let currentPicker, self.ownsCurrentSession,
                  !self.isReconfiguringPicker, self.picker === currentPicker,
                  self.nativePenReflectionRevision == revision,
                  self.pendingPenSelection == nil else { return }
            // A pending explicit request wins over the palette's old selection;
            // native changes never issue another explicit selection request.
            self.reflectNativePenSelection(syncToolAttributes: syncToolAttributes)
        }
    }

    private func reflectNativePenSelection(syncToolAttributes: Bool) {
        guard ownsCurrentSession, ownsActivePalette else { return }
        // An older native picker can still deliver a callback while an edit/reorder
        // is waiting for the next run-loop turn. The saved configuration wins.
        guard !syncToolAttributes || !paletteConfigurationChanged else {
            schedulePickerRefresh()
            return
        }
        let item = picker.selectedToolItem
        let selected = store.savedPens.first(where: { $0.toolIdentifier == item.identifier })
        if item.identifier != Self.writingAidIdentifier { store.noteSelectedSavedPen(selected?.id) }
        if syncToolAttributes, let selected, let inkItem = item as? PKToolPickerInkingItem,
           let ink = storedInk(inkItem.inkingTool) {
            let wasSynchronized = !paletteConfigurationChanged
            store.updateSavedPenTool(id: selected.id, red: ink.red, green: ink.green,
                                     blue: ink.blue, alpha: ink.alpha, width: ink.width)
            if wasSynchronized, let index = installedPens.firstIndex(where: { $0.id == selected.id }),
               let normalizedPen = store.savedPens.first(where: { $0.id == selected.id }) {
                // This change already happened inside the existing native item.
                // Reflect it in the installed snapshot so a color/width slider does
                // not continually rebuild and dismiss the palette it is editing.
                installedPens[index] = normalizedPen
            }
        }
        if !(item is PKToolPickerLassoItem) { usesNativeStrokeLasso = false }
        schedulePickerPersistence()
        if paletteConfigurationChanged { schedulePickerRefresh() }
        restoreCustomEraserSettings()
        reconcileDockedPickerTool()
        enforcePickerDrawingPermissions()
        synchronizeDockedPalette()
        synchronizeLasso()
    }

    private func storedInk(_ tool: PKInkingTool) -> StoredInk? {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard tool.color.resolvedColor(with: canvas.traitCollection).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
        return StoredInk(red: Double(red), green: Double(green), blue: Double(blue),
                         alpha: Double(alpha), width: Double(tool.width))
    }

    private func schedulePickerPersistence() {
        guard ownsCurrentSession else { return }
        pendingPickerPersistence?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.ownsCurrentSession else { return }
            self.pendingPickerPersistence = nil
            self.persistPickerState()
        }
        pendingPickerPersistence = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    private func persistPickerState() {
        guard ownsCurrentSession, ownsActivePalette else { return }
        let selectedIdentifier = picker.selectedToolItemIdentifier == Self.writingAidIdentifier
            ? (lastNonEraserItemIdentifier.flatMap { value in value != Self.writingAidIdentifier ? value : nil }
                ?? store.savedPens.first?.toolIdentifier ?? Self.emptyPaletteIdentifier)
            : picker.selectedToolItemIdentifier
        let state = StoredPickerState(ink: [:], selectedIdentifier: selectedIdentifier,
                                      rulerActive: picker.isRulerActive)
        guard let data = try? JSONEncoder().encode(state) else { return }
        UserDefaults.standard.set(data, forKey: Self.pickerStateKey)
    }

    private func perform(_ command: CanvasCommand) {
        guard ownsCurrentSession, !store.isBusy else { return }
        if mergePlacement != nil {
            switch command.action {
            case .undo, .redo, .toggleRuler, .showPalette, .capture: return
            default: break
            }
        }
        if !isEmbeddedCanvas, let active = Self.activePaletteHost, active !== self,
           active.store.childRoot === store.childRoot, active.window != nil {
            switch command.action {
            case .undo, .redo, .toggleRuler, .showPalette: active.perform(command); return
            default: break
            }
        }
        if !store.canEditBoardContents {
            switch command.action {
            case .undo, .redo, .toggleRuler, .showPalette, .capture: return
            default: break
            }
        }
        switch command.action {
        case .restoreViewport(let point, let zoom):
            setViewport(center: point, zoom: zoom)
            return
        case .fitRegion(let rect):
            guard !snapshotInteractionActive, rect.isFiniteCanvasRect, !rect.isEmpty,
                  bounds.width > 0, bounds.height > 0 else { return }
            let padding = min(64, min(bounds.width, bounds.height) * 0.2)
            let fit = min((bounds.width - 2 * padding) / rect.width,
                          (bounds.height - 2 * padding) / rect.height, 1.5)
            setViewport(center: CGPoint(x: rect.midX, y: rect.midY), zoom: fit)
            // Locating is navigation even while editing: do not dirty/save the board.
            return
        case .fitAll:
            var contentBounds = CGRect.null
            if !canvas.drawing.strokes.isEmpty, canvas.drawing.bounds.isFiniteCanvasRect {
                contentBounds = canvas.drawing.bounds
            }
            for item in store.document.items {
                let rect = item.canvasWorldRect
                if rect.isFiniteCanvasRect { contentBounds = contentBounds.union(rect) }
            }
            for item in store.document.items {
                for link in item.childBoards ?? [] where link.presentation?.expanded == true {
                    if let presentation = link.presentation { contentBounds = contentBounds.union(presentation.rect) }
                }
            }
            for frame in store.printFrames { contentBounds = contentBounds.union(frame.rect) }
            guard contentBounds.isFiniteCanvasRect, !contentBounds.isEmpty else {
                setViewport(center: CGPoint(x: Self.worldExtent / 2, y: Self.worldExtent / 2), zoom: 1)
                return
            }
            let padded = contentBounds.insetBy(dx: -60, dy: -60)
            let fit = min(bounds.width / padded.width, bounds.height / padded.height, 1)
            setViewport(center: CGPoint(x: padded.midX, y: padded.midY), zoom: fit)
        case .zoomIn:
            setViewport(center: viewportWorldCenter, zoom: canvas.zoomScale * 1.3)
        case .zoomOut:
            setViewport(center: viewportWorldCenter, zoom: canvas.zoomScale / 1.3)
        case .undo:
            if lassoWorkActive { cancelLassoWork(); lassoStatus = ""; updateLassoOverlay() }
            lassoOverlay.cancelInteraction()
            boardUndoManager?.undo()
            refreshBackdrop()
        case .redo:
            if lassoWorkActive { cancelLassoWork(); lassoStatus = ""; updateLassoOverlay() }
            lassoOverlay.cancelInteraction()
            boardUndoManager?.redo()
            refreshBackdrop()
        case .toggleRuler:
            if !store.nativePaletteEntries.contains(.ruler) { store.restoreNativePaletteUtility(.ruler) }
            picker.isRulerActive.toggle()
            if store.mode != .ink { store.mode = .ink }
            showPalette()
            return
        case .showPalette:
            if store.mode != .ink { store.mode = .ink }
            paletteDockSettings = .load()
            paletteDockSettings.isMinimized = false
            paletteDockSettings.save()
            showPalette()
            return
        case .jump(let point, let zoom):
            setViewport(center: point, zoom: zoom)
        case .capture:
            captureViewport()
        }
        // Placement camera commands must never publish a new target snapshot;
        // confirmation still compares the exact inspected source/target bytes.
        if mergePlacement == nil && store.canEditBoardContents { markChanged() }
    }

    /// Read the final native state only after all live editing gestures ended.
    /// Used before entering read-only; no cancelled gesture or partial ink is discarded.
    func prepareForReading() -> Bool {
        guard ownsCurrentSession, !snapshotInteractionActive else { return false }
        if canvas.drawing != store.drawing {
            if store.canEditBoardContents {
                lastDrawing = canvas.drawing; nativeInkRevision &+= 1
                store.drawing = lastDrawing; store.changedInk()
            } else { applyDrawing(store.drawing) }
        }
        return true
    }

    var snapshotSessionID: UUID { canvasSessionID }
    /// Translation may capture only an already rendered PDF page, never a blank
    /// loading placeholder. A small overview is insufficient for word reading.
    func hasTranslationPreview(for id: UUID) -> Bool {
        guard let image = backdrop.previewImage(for: id), let pixels = image.cgImage else { return false }
        return max(pixels.width, pixels.height) >= 256
    }
    var snapshotBounds: CGRect { bounds }
    var snapshotInteractionActive: Bool {
        let gestures = [canvas.drawingGestureRecognizer, canvas.panGestureRecognizer,
                        readingOverlayPan, readingOverlayPinch]
            + (canvas.pinchGestureRecognizer.map { [$0] } ?? [])
            + (interactionSurface.gestureRecognizers ?? []) + (reviewSurface.gestureRecognizers ?? [])
        return lassoOverlay.isInteracting || store.externalInteractionActive || isUsingDrawingTool || canvas.isTracking || canvas.isDragging
            || inlineTextSelection?.hasSelection == true
            || canvas.isDecelerating || canvas.isZooming
            || gestures.contains { $0.state == .began || $0.state == .changed }
    }

    /// Separate from the saved board preview: no command, dirty flag, selection,
    /// viewport update, clipboard write or source-file write occurs here.
    func temporarySnapshot(in rect: CGRect) -> UIImage? {
        boundedSnapshot(in: rect, maximumDimension: 1600)
    }

    private func textSelectionSnapshot(for key: BoardTextSelectionSnapshotKey) async -> UIImage? {
        guard !Task.isCancelled, ownsCurrentSession, textSelectionKey == key,
              !snapshotInteractionActive, key.renderScale > 0 else { return nil }
        let crop = bounds.standardized
        let format = UIGraphicsImageRendererFormat()
        format.scale = key.renderScale
        format.opaque = true
        // UIKit layers remain on the main actor. This copies the already cached
        // background only; no native drawing rasterization occurs here.
        guard backdrop.prepareForCapture() else { return nil }
        backdrop.layer.displayIfNeeded()
        let background = UIGraphicsImageRenderer(size: crop.size, format: format).image { renderer in
            renderer.cgContext.translateBy(x: -crop.minX, y: -crop.minY)
            backdrop.layer.render(in: renderer.cgContext)
        }
        let request = BoardTextSelectionInkRenderRequest(drawing: canvas.drawing,
            background: background, size: crop.size, imageScale: key.renderScale,
            worldRect: CGRect(origin: key.worldPoint(for: crop.origin),
                size: CGSize(width: crop.width / key.zoom, height: crop.height / key.zoom)),
            inkScale: key.zoom * key.renderScale)
        let token = BoardPreviewCancellation()
        return await withTaskCancellationHandler(operation: {
            let image = await BoardTextSelectionInkRenderer.shared.image(request, token: token)
            guard !Task.isCancelled, !token.isCancelled, self.ownsCurrentSession,
                  self.textSelectionKey == key, !self.snapshotInteractionActive else { return nil }
            return image
        }, onCancel: { token.cancel() })
    }

    private func boundedSnapshot(in rect: CGRect, maximumDimension: CGFloat) -> UIImage? {
        guard ownsCurrentSession, !store.isBusy, !snapshotInteractionActive, initialViewportApplied,
              canvas.zoomScale > 0, rect.origin.x.isFinite, rect.origin.y.isFinite,
              rect.width.isFinite, rect.height.isFinite else { return nil }
        let crop = rect.standardized.intersection(bounds)
        guard !crop.isNull, crop.width >= 8, crop.height >= 8 else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = min(2, maximumDimension / max(crop.width, crop.height), sqrt(6_000_000 / (crop.width * crop.height)))
        format.opaque = true
        let world = CGRect(origin: worldPoint(crop.origin),
                           size: CGSize(width: crop.width / canvas.zoomScale,
                                        height: crop.height / canvas.zoomScale))
        var paperInk: UIImage?
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            paperInk = canvas.drawing.image(from: world, scale: canvas.zoomScale * format.scale)
        }
        guard let ink = paperInk else { return nil }
        guard backdrop.prepareForCapture() else { return nil }
        backdrop.layer.displayIfNeeded()
        return UIGraphicsImageRenderer(size: crop.size, format: format).image { context in
            context.cgContext.saveGState()
            context.cgContext.translateBy(x: -crop.minX, y: -crop.minY)
            backdrop.layer.render(in: context.cgContext)
            context.cgContext.restoreGState()
            ink.draw(in: CGRect(origin: .zero, size: crop.size))
        }
    }

    /// Produces a viewport-sized bitmap even when zoomed far out on 2,000 pages.
    private func captureViewport() {
        guard ownsCurrentSession, !store.isBusy, !snapshotInteractionActive,
              bounds.width > 0, bounds.height > 0, canvas.zoomScale.isFinite, canvas.zoomScale > 0 else { return }
        let format = UIGraphicsImageRendererFormat()
        format.scale = min(window?.screen.scale ?? 2, 2)
        format.opaque = true
        let visible = CGRect(origin: worldPoint(.zero),
                             size: CGSize(width: bounds.width / canvas.zoomScale,
                                          height: bounds.height / canvas.zoomScale))
        var paperInk: UIImage?
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            paperInk = canvas.drawing.image(from: visible, scale: canvas.zoomScale * format.scale)
        }
        guard let ink = paperInk else { return }
        guard backdrop.prepareForCapture() else { return }
        backdrop.layer.displayIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { context in
            backdrop.layer.render(in: context.cgContext)
            ink.draw(in: bounds)
        }
        store.requestSnapshot(image)
    }

    @objc private func openReadingVideo(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, ownsCurrentSession, (store.isPadReading || store.usesPhoneInterface),
              !store.isBusy, !store.reviewModeEnabled, let root = store.vaultURL else { return }
        let point = worldPoint(recognizer.location(in: self))
        guard let item = store.document.items.reversed().first(where: { $0.canvasWorldRect.contains(point) }),
              BoardVideo.isVideo(item), let path = item.sourcePath else { return }
        videoOverlay.stop()
        onOpenVideo?(BoardVideoRequest(rootURL: root, relativePath: path, title: item.title))
    }

    private func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
        guard recognizer.state == .ended, ownsCurrentSession, store.canEditBoardContents,
              !store.reviewModeEnabled, store.mode == .arrange, !store.isBusy,
              let onEditItem else { return }
        let screenPoint = recognizer.location(in: interactionSurface)
        let point = worldPoint(screenPoint)
        guard let item = store.document.items.reversed().first(where: { $0.canvasWorldRect.contains(point) }) else { return }
        // Text/formula bodies are editable. A document's title strip edits only
        // the card label; rendered PDF pages and ink groups retain their readers.
        if item.kind == .document {
            let card = screenRect(for: item.canvasWorldRect)
            let titleHeight = min(34, max(12, 28 * canvas.zoomScale))
            guard screenPoint.y <= card.minY + titleHeight else { return }
        } else if item.kind != .text && item.kind != .formula { return }
        store.selectedIDs = [item.id]
        refreshBackdrop()
        onEditItem(item)
    }

    private func handleTap(_ recognizer: UITapGestureRecognizer) {
        guard ownsCurrentSession, !store.isPadReading, [.arrange, .place, .paper].contains(store.mode), !store.isBusy else { return }
        let point = worldPoint(recognizer.location(in: interactionSurface))
        if isEmbeddedCanvas { activateInputPalette() }
        if store.mode == .paper {
            if store.printTool == .place { store.placePrintPage(at: point) }
            else if store.printTool == .select {
                store.selectedPrintFrameID = store.printFrame(at: point)?.id
                store.selectedIDs = []
            }
            refreshBackdrop()
            return
        }
        if store.mode == .place, let placement = mergePlacement, placement.canvasSessionID == canvasSessionID {
            placement.choose(point)
            synchronizeMergePlacement()
            return
        }
        if store.mode == .place {
            guard point.x.isFinite, point.y.isFinite, point.x >= 0, point.y >= 0,
                  point.x < Self.worldExtent, point.y < Self.worldExtent else {
                store.status = String(localized: "这里已超出画布边缘，请放大后重新选位置")
                return
            }
            store.insertionPoint = point
            store.mode = store.usesPhoneInterface ? .ink : .arrange
            if !store.usesPhoneInterface { store.status = String(localized: "位置已选；文件和展开页面将从标记处开始") }
            refreshBackdrop()
            return
        }
        guard store.canEditBoardContents else { return }
        if let item = store.document.items.reversed().first(where: { $0.canvasWorldRect.contains(point) }) {
            if store.selectedIDs.contains(item.id) { store.selectedIDs.remove(item.id) }
            else { store.selectedIDs.insert(item.id) }
        } else {
            store.selectedIDs.removeAll()
        }
        refreshBackdrop()
    }

    private func handlePan(_ recognizer: UIPanGestureRecognizer) {
        if ownsCurrentSession, [.ended, .cancelled, .failed].contains(recognizer.state) { store.externalInteractionActive = false }
        guard ownsCurrentSession, !store.isBusy, (!store.isPadReading || store.reviewModeEnabled) else {
            interactionSurface.selectionRect = nil
            dragOrigins.removeAll()
            draggedPrintFrame = nil
            return
        }
        let screen = recognizer.location(in: interactionSurface)
        let point = worldPoint(screen)
        switch recognizer.state {
        case .began:
            store.externalInteractionActive = true
            if isEmbeddedCanvas { activateInputPalette() }
            feedback.prepare()
            panStartWorld = point
            panStartOffset = canvas.contentOffset
            dragOrigins.removeAll()
            draggedAnything = false
            draggedPrintFrame = nil
            if store.canEditBoardContents, store.mode == .paper, store.printTool == .select,
               let frame = store.printFrame(at: point) {
                draggedPrintFrame = frame
                store.selectedPrintFrameID = frame.id
                store.selectedIDs = []
            }
            if store.canEditBoardContents, store.mode == .arrange,
               let item = store.document.items.reversed().first(where: { $0.canvasWorldRect.contains(point) }) {
                if !store.selectedIDs.contains(item.id) { store.selectedIDs = [item.id] }
                for selected in store.document.items where store.selectedIDs.contains(selected.id) {
                    dragOrigins[selected.id] = CGPoint(x: selected.x, y: selected.y)
                }
            }
        case .changed:
            if store.mode == .frame || (store.mode == .paper && [.region, .exportRegion].contains(store.printTool)) {
                interactionSurface.selectionRect = screenRect(for: rectangle(from: panStartWorld, to: point))
            } else if let original = draggedPrintFrame,
                      let index = store.document.printFrames?.firstIndex(where: { $0.id == original.id }) {
                let delta = recognizer.translation(in: interactionSurface)
                store.document.printFrames?[index].x = min(max(0, original.x + delta.x / canvas.zoomScale), Self.worldExtent - original.width)
                store.document.printFrames?[index].y = min(max(0, original.y + delta.y / canvas.zoomScale), Self.worldExtent - original.height)
                draggedAnything = true
                markChanged()
                refreshBackdrop()
            } else if !dragOrigins.isEmpty {
                let delta = recognizer.translation(in: interactionSurface)
                for index in store.document.items.indices {
                    let item = store.document.items[index]
                    guard let origin = dragOrigins[item.id] else { continue }
                    store.moveItemWithChildren(index: index, to: CGPoint(x: origin.x + delta.x / canvas.zoomScale,
                                                                         y: origin.y + delta.y / canvas.zoomScale))
                }
                draggedAnything = true
                markChanged()
                refreshBackdrop()
            } else {
                let delta = recognizer.translation(in: interactionSurface)
                setClampedOffset(CGPoint(x: panStartOffset.x - delta.x, y: panStartOffset.y - delta.y))
                viewportDidChange(userInitiated: true)
            }
        case .ended, .cancelled, .failed:
            if store.mode == .paper, [.region, .exportRegion].contains(store.printTool), recognizer.state == .ended {
                let rect = rectangle(from: panStartWorld, to: point)
                if rect.width * canvas.zoomScale > 12, rect.height * canvas.zoomScale > 12 {
                    store.capturePrintRegion(rect, forExport: store.printTool == .exportRegion)
                }
            } else if store.mode == .frame, recognizer.state == .ended {
                let rect = rectangle(from: panStartWorld, to: point)
                if rect.width * canvas.zoomScale > 12, rect.height * canvas.zoomScale > 12 {
                    let previousItemCount = store.document.items.count
                    store.makeNode(from: canvas.drawing, rect: rect)
                    applyDrawing(store.drawing)
                    if store.document.items.count > previousItemCount {
                        feedback.pathCompleted(at: screen)
                    }
                }
            } else if draggedAnything {
                if let original = draggedPrintFrame { registerPrintFrameUndo(original) }
                else { registerMoveUndo(dragOrigins) }
                flushChanged()
            }
            interactionSurface.selectionRect = nil
            dragOrigins.removeAll()
            draggedPrintFrame = nil
            refreshBackdrop()
        default: break
        }
    }

    private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
        guard ownsCurrentSession, !store.isBusy, (!store.isPadReading || store.reviewModeEnabled) else { return }
        let location = recognizer.location(in: interactionSurface)
        switch recognizer.state {
        case .began:
            pinchStartZoom = canvas.zoomScale
            pinchAnchorWorld = worldPoint(location)
            interactionSurface.selectionRect = nil
        case .changed:
            applyingViewport = true
            canvas.setZoomScale(min(canvas.maximumZoomScale, max(canvas.minimumZoomScale, pinchStartZoom * recognizer.scale)), animated: false)
            setClampedOffset(CGPoint(x: pinchAnchorWorld.x * canvas.zoomScale - location.x,
                                    y: pinchAnchorWorld.y * canvas.zoomScale - location.y))
            applyingViewport = false
            viewportDidChange(userInitiated: true)
        case .ended, .cancelled:
            flushChanged()
        default: break
        }
    }

    /// The sheet keeps its draft until this synchronous transaction succeeds.
    /// Use PencilKit's existing manager so text, node moves and ink share order.
    @discardableResult
    func commitExistingTextEdit(_ updated: BoardItem, expected: BoardItem,
                                boardID: UUID, sessionID: UUID) -> Bool {
        guard ownsCurrentSession, canvasSessionID == sessionID, store.document.id == boardID,
              !store.isBusy, store.canEditBoardContents,
              updated.id == expected.id, updated.kind == expected.kind,
              expected.kind == .text || expected.kind == .formula,
              let index = store.document.items.firstIndex(where: { $0.id == expected.id }) else {
            store.status = String(localized: "白板正在处理或已切换，输入内容仍保留，请重新打开编辑。")
            return false
        }
        guard store.document.items[index] == expected else {
            store.status = String(localized: "内容在编辑期间已变化，请关闭后重新打开。")
            return false
        }
        let previous = BoardTextEditContent(expected), next = BoardTextEditContent(updated)
        guard previous != next else { return true }
        guard let undo = boardUndoManager, undo.isUndoRegistrationEnabled else {
            store.status = String(localized: "白板撤销服务尚未准备好，输入内容仍保留，请稍后再点保存。")
            return false
        }
        undo.beginUndoGrouping()
        registerTextEditUndo(previous, expected: next, itemID: expected.id,
                             kind: expected.kind, boardID: boardID, sessionID: sessionID)
        undo.endUndoGrouping()
        applyTextEdit(next, at: index)
        return true
    }

    private func registerTextEditUndo(_ previous: BoardTextEditContent, expected: BoardTextEditContent,
                                      itemID: UUID, kind: BoardItemKind, boardID: UUID, sessionID: UUID) {
        boardUndoManager?.registerUndo(withTarget: self) { host in
            guard host.ownsCurrentSession, host.canvasSessionID == sessionID,
                  host.store.document.id == boardID, !host.store.isBusy, host.store.canEditBoardContents,
                  let index = host.store.document.items.firstIndex(where: { $0.id == itemID }),
                  host.store.document.items[index].kind == kind,
                  let undo = host.boardUndoManager, undo.isUndoRegistrationEnabled else { return }
            let current = BoardTextEditContent(host.store.document.items[index])
            guard current == expected else {
                host.store.status = String(localized: "文字在此后已变化，未覆盖当前内容。")
                return
            }
            host.registerTextEditUndo(current, expected: previous, itemID: itemID,
                                      kind: kind, boardID: boardID, sessionID: sessionID)
            host.applyTextEdit(previous, at: index)
        }
        boardUndoManager?.setActionName(String(localized: "编辑文字"))
    }

    private func applyTextEdit(_ content: BoardTextEditContent, at index: Int) {
        content.apply(to: &store.document.items[index])
        store.document.previewPNG = nil
        store.refreshPreviews()
        refreshBackdrop()
        markChanged()
    }

    private func registerPrintFrameUndo(_ previous: BoardPrintFrame) {
        boardUndoManager?.registerUndo(withTarget: self) { host in
            guard host.ownsCurrentSession, !host.store.isBusy,
                  let current = host.store.printFrames.first(where: { $0.id == previous.id }) else { return }
            host.registerPrintFrameUndo(current)
            host.store.updatePrintFrame(previous)
            host.refreshBackdrop()
        }
        boardUndoManager?.setActionName(String(localized: "移动打印框"))
    }

    private func registerMoveUndo(_ positions: [UUID: CGPoint]) {
        boardUndoManager?.registerUndo(withTarget: self) { host in host.restorePositions(positions) }
        boardUndoManager?.setActionName(String(localized: "移动节点"))
    }

    private func restorePositions(_ positions: [UUID: CGPoint]) {
        guard ownsCurrentSession, !store.isBusy, store.canEditBoardContents else { return }
        var inverse: [UUID: CGPoint] = [:]
        for index in store.document.items.indices {
            let item = store.document.items[index]
            guard let position = positions[item.id] else { continue }
            inverse[item.id] = CGPoint(x: item.x, y: item.y)
            store.moveItemWithChildren(index: index, to: position)
        }
        registerMoveUndo(inverse)
        refreshBackdrop()
        flushChanged()
    }

    private func rectangle(from a: CGPoint, to b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }

    private func screenRect(for rect: CGRect) -> CGRect {
        CGRect(x: rect.minX * canvas.zoomScale - canvas.contentOffset.x,
               y: rect.minY * canvas.zoomScale - canvas.contentOffset.y,
               width: rect.width * canvas.zoomScale, height: rect.height * canvas.zoomScale)
    }

    private func screenOutline(for outline: [CGPoint]?) -> [CGPoint]? {
        outline?.map { CGPoint(x: $0.x * canvas.zoomScale - canvas.contentOffset.x,
                              y: $0.y * canvas.zoomScale - canvas.contentOffset.y) }
    }

    private func markChanged() {
        guard ownsCurrentSession, !store.isBusy, store.canEditBoardContents else { return }
        // Dirty state must be synchronous: backgrounding or switching boards can
        // happen between any two input events. BoardStore debounces only disk I/O.
        store.changed()
    }

    private func markInkChanged() {
        guard ownsCurrentSession, !store.isBusy, store.canEditBoardContents else { return }
        store.changedInk()
    }

    private func markViewportChanged() {
        guard mergePlacement == nil, ownsCurrentSession, !store.isBusy, store.canEditBoardContents else { return }
        store.changedViewport()
    }

    private func flushChanged() {
        markChanged()
    }

    // A single app-owned lasso selects both vector ink and linked board items.
    // Its lifetime is local to this canvas session; selection never dirties a board.
    private var lassoEnabled: Bool {
        ownsCurrentSession && ownsActivePalette && store.canEditBoardContents && !store.isBusy
            && store.mode == .ink && picker.selectedToolItem is PKToolPickerLassoItem
            && !usesNativeStrokeLasso
    }

    private func configureLasso() {
        lassoOverlay.isHidden = true
        lassoOverlay.attachPencilInput(to: self) { [weak self] touch in
            guard let self, !self.isTornDown, self.window != nil, self.lassoEnabled,
                  let view = touch.view else { return false }
            // A recognizer on the common ancestor can also see floating toolbars
            // and embedded canvases. Only this canvas and its selection UI own
            // this lasso session; never intercept controls or another canvas.
            return view === self.canvas || view.isDescendant(of: self.canvas)
                || view === self.lassoOverlay || view.isDescendant(of: self.lassoOverlay)
        }
        lassoViewportPinch.delegate = self
        lassoViewportPinch.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        addGestureRecognizer(lassoViewportPinch)
        lassoOverlay.onInteractionChanged = { [weak self] active in
            guard let self, self.ownsCurrentSession else { return }
            self.store.externalInteractionActive = active || self.lassoWorkActive
        }
        lassoOverlay.onBeginPath = { [weak self] in
            guard let self else { return }
            self.lassoPathStartCamera = "\(self.viewportRevision)|\(self.bounds.width)|\(self.bounds.height)|\(self.canvas.zoomScale)|\(self.canvas.contentOffset.x)|\(self.canvas.contentOffset.y)"
        }
        lassoOverlay.onSelectPath = { [weak self] points in
            guard let self, self.lassoEnabled else { return }
            self.lassoInputContext = "source:pencil,start:\(self.lassoPathStartCamera),end:\(self.viewportRevision)|\(self.bounds.width)|\(self.bounds.height)|\(self.canvas.zoomScale)|\(self.canvas.contentOffset.x)|\(self.canvas.contentOffset.y)"
            self.selectLasso(points.map { self.worldPoint($0) })
        }
        lassoOverlay.onTypesChanged = { [weak self] types in
            guard let self, self.lassoEnabled else { return }
            self.lassoTypes = types
            UserDefaults.standard.set(Array(types).sorted(), forKey: "InkSpace.lassoTypes.v1")
            self.lassoInputContext = "source:types"
            if !self.lassoPolygon.isEmpty {
                self.selectLasso(self.lassoPolygon, preservingOutline: self.lassoSelection?.outline != nil)
            }
            else { self.updateLassoOverlay() }
        }
        lassoOverlay.onSelectVisible = { [weak self] in
            guard let self, self.lassoEnabled else { return }
            self.lassoInputContext = "source:visible"
            let rect = self.bounds.insetBy(dx: 12, dy: 12)
            self.selectLasso([CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY),
                CGPoint(x: rect.maxX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.maxY)].map { self.worldPoint($0) }, preservingOutline: false)
        }
        lassoOverlay.onDuplicateSelection = { [weak self] in self?.copyLassoSelection(duplicate: true) }
        lassoOverlay.onCopySelection = { [weak self] in self?.copyLassoSelection(duplicate: false) }
        lassoOverlay.onPasteSelection = { [weak self] in self?.pasteLassoClipboard() }
        lassoOverlay.onClearSelection = { [weak self] in self?.clearLassoSelection(); self?.refreshBackdrop() }
        lassoOverlay.onBeginTransform = { [weak self] kind, point in self?.beginLassoTransform(kind, at: point) }
        lassoOverlay.onUpdateTransform = { [weak self] point in self?.previewLassoTransform(at: point) }
        lassoOverlay.onEndTransform = { [weak self] cancelled in self?.finishLassoTransform(cancelled: cancelled) }
        lassoOverlay.onScale = { [weak self] scale in
            guard let self, self.validLassoSnapshot, let snapshot = self.lassoSnapshot else { return }
            self.commitLassoTransform(snapshot: snapshot, scale: scale, anchor: CGPoint(x: snapshot.selection.bounds.midX, y: snapshot.selection.bounds.midY))
        }
        lassoOverlay.onNativeLasso = { [weak self] in
            guard let self else { return }
            self.clearLassoSelection(); self.usesNativeStrokeLasso = true; self.synchronizeLasso()
        }
        lassoOverlay.onClose = { [weak self] in
            guard let self else { return }
            self.clearLassoSelection()
            if let pen = self.store.savedPens.first(where: { $0.toolIdentifier == self.previousPencilItemIdentifier }) ?? self.store.savedPens.first {
                self.selectDockedTool(pen.toolIdentifier)
            } else { self.usesNativeStrokeLasso = true }
            self.synchronizeLasso()
        }
    }

    private func synchronizeLasso() {
        synchronizePickerCanvasOwnership()
        scheduleResponderPolicy()
        // addObserver registers future callbacks; do not rely on it replaying
        // the current tool when returning from the custom lasso to native lasso.
        if usesNativeStrokeLasso, let item = picker.selectedToolItem as? PKToolPickerLassoItem,
           (canvas.tool as? PKLassoTool) != item.lassoTool {
            canvas.tool = item.lassoTool
        }
        let enabled = lassoEnabled
        if !enabled, !lassoOverlay.isHidden {
            lassoOverlay.cancelInteraction()
            clearLassoSelection()
        }
        lassoOverlay.isHidden = !enabled
        lassoViewportPinch.isEnabled = enabled
        enforcePickerDrawingPermissions()
        if enabled {
            lassoOverlay.toolbarTopInset = paletteDockSettings.edge == .top ? 72 : 0
            bringSubviewToFront(lassoOverlay)
            if !dockedPalette.isHidden { bringSubviewToFront(dockedPalette) }
            if !pencilArc.isHidden { bringSubviewToFront(pencilArc) }
            if lassoSnapshot != nil && !validLassoSnapshot { clearLassoSelection() }
        }
        updateLassoOverlay()
        synchronizeTextSelection()
    }

    private var validLassoSnapshot: Bool {
        guard lassoEnabled, lassoSnapshotInkRevision == nativeInkRevision, let snapshot = lassoSnapshot else { return false }
        return canvas.drawing == snapshot.drawing && store.drawing == snapshot.drawing && store.document.items == snapshot.items
    }

    private func selectLasso(_ polygon: [CGPoint], preservingOutline: Bool = true) {
        guard lassoEnabled else { return }
        cancelLassoWork()
        // Retire the previous selection before starting a new request. A failed
        // or cancelled large lasso must never leave an older selection active.
        lassoSelection = nil; lassoSnapshot = nil; lassoSnapshotInkRevision = nil
        lassoPolygon = polygon
        if !store.selectedIDs.isEmpty { store.selectedIDs.removeAll() }
        let drawing = canvas.drawing, items = store.document.items
        let size = CGSize(width: store.document.canvasWidth, height: store.document.canvasHeight)
        let kinds = Set(lassoTypes.compactMap(BoardLassoSelection.Kind.init(rawValue:)))
        let diagnosticContext = lassoInputContext + ",points:\(polygon.count)"
        lassoInputDiagnostic = diagnosticContext + ",result:working"
        let token = UUID(), session = store.canvasSessionID, boardID = store.document.id, inkRevision = nativeInkRevision
        lassoWorkID = token; store.externalInteractionActive = true
        lassoStatus = String(localized: "正在选择内容，可点完成取消…")
        updateLassoOverlay()
        let task = Task.detached(priority: .userInitiated) {
            try autoreleasepool { try BoardLassoSelection.select(polygon: polygon, drawing: drawing,
                items: items, kinds: kinds, canvasSize: size) }
        }
        lassoSelectionTask = task
        Task { [weak self] in
            let result = await task.result
            guard let self, self.lassoWorkID == token else { return }
            defer { self.finishLassoWork(token) }
            guard self.ownsCurrentSession, self.store.canvasSessionID == session, self.store.document.id == boardID,
                  self.lassoEnabled, self.nativeInkRevision == inkRevision,
                  self.store.drawing == drawing, self.store.document.items == items else { return }
            switch result {
            case .success(var selection):
                if !preservingOutline { selection.outline = nil }
                self.lassoInputDiagnostic = diagnosticContext + ",result:selected,strokes:\(selection.strokeIndices.count),items:\(selection.itemIDs.count)"
                self.lassoPolygon = selection.outline ?? polygon
                self.lassoSelection = selection.isEmpty ? nil : selection
                self.lassoSnapshot = selection.isEmpty ? nil : BoardLassoSelection.Snapshot(drawing: drawing, items: items, selection: selection, canvasSize: size)
                self.lassoSnapshotInkRevision = selection.isEmpty ? nil : inkRevision
                self.store.selectedIDs = selection.itemIDs
                self.lassoStatus = selection.isEmpty ? String(localized: "没有选中这些类型的内容") : ""
            case .failure(let error):
                if !(error is CancellationError) {
                    self.lassoStatus = error.localizedDescription
                    self.lassoInputDiagnostic = diagnosticContext + ",result:failed," + BoardLassoSelection.polygonDiagnostics(polygon, canvasSize: size)
                } else { self.lassoInputDiagnostic = diagnosticContext + ",result:cancelled" }
            }
            self.refreshBackdrop()
        }
    }

    private func lassoClipboardContext() -> BoardLassoClipboard.ReferenceContext? {
        guard let root = store.vaultURL, let board = store.boardURL,
              let path = store.relativePath(for: board) else { return nil }
        let canonical = root.standardizedFileURL.resolvingSymlinksInPath().path
        let identity = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
        return BoardLassoClipboard.ReferenceContext(vaultID: identity, boardID: store.document.id, boardPath: path)
    }

    private func lassoClipboardUndoState() -> LassoClipboardUndoState {
        LassoClipboardUndoState(drawing: canvas.drawing, items: store.document.items,
            edges: store.document.edges, selection: lassoSelection ?? BoardLassoSelection.Selection(),
            canvasSize: CGSize(width: store.document.canvasWidth, height: store.document.canvasHeight))
    }

    private func copyLassoSelection(duplicate: Bool) {
        guard ownsCurrentSession, store.canEditBoardContents, !store.isBusy, !lassoWorkActive,
              validLassoSnapshot, let snapshot = lassoSnapshot,
              let context = lassoClipboardContext() else { return }
        let edges = store.document.edges, previous = lassoClipboardUndoState()
        let offset = 24 / max(canvas.zoomScale, canvas.minimumZoomScale)
        let preferred = CGSize(width: offset, height: offset)
        let world = CGRect(origin: .zero, size: snapshot.canvasSize)
        let translation = world.contains(snapshot.selection.bounds.offsetBy(dx: offset, dy: offset)) ? preferred : .zero
        beginLassoClipboard(previous: previous, message: duplicate
            ? String(localized: "正在复制圈选内容…") : String(localized: "正在复制到剪贴板…")) {
            if duplicate {
                return .inserted(try BoardLassoClipboard.duplicate(snapshot: snapshot, edges: edges,
                    context: context, translation: translation))
            }
            let envelope = try BoardLassoClipboard.makeEnvelope(snapshot: snapshot, edges: edges, context: context)
            let data = try BoardLassoClipboard.encode(envelope)
            let texts = snapshot.items.filter { snapshot.selection.itemIDs.contains($0.id) }.compactMap { $0.text }
            let fallbackLimit = 1_024 * 1_024
            var fallbackBytes = 0
            for text in texts {
                try Task.checkCancellation()
                let count = text.utf8.count
                if count > fallbackLimit - min(fallbackBytes, fallbackLimit) { fallbackBytes = fallbackLimit + 1; break }
                fallbackBytes += count + 2
            }
            // The native bundle always remains complete. Omit an oversized
            // optional plain-text representation rather than truncating it.
            let text = fallbackBytes <= fallbackLimit ? texts.joined(separator: "\n\n") : ""
            return .copied(data, text)
        }
    }

    private func pasteLassoClipboard() {
        guard ownsCurrentSession, lassoEnabled, store.canEditBoardContents, !store.isBusy, !lassoWorkActive,
              let context = lassoClipboardContext() else { return }
        // Reading follows the user's explicit Paste action; inspecting or drawing
        // a selection never touches the system clipboard.
        guard let data = UIPasteboard.general.data(forPasteboardType: BoardLassoClipboard.typeIdentifier) else {
            lassoStatus = String(localized: "剪贴板没有已复制的圈选内容。")
            updateLassoOverlay(); return
        }
        let previous = lassoClipboardUndoState()
        let point = store.insertionPoint ?? CGPoint(x: max(0, viewportWorldCenter.x - 100 / max(canvas.zoomScale, canvas.minimumZoomScale)),
            y: max(0, viewportWorldCenter.y - 60 / max(canvas.zoomScale, canvas.minimumZoomScale)))
        beginLassoClipboard(previous: previous, message: String(localized: "正在粘贴圈选内容…")) {
            let envelope = try BoardLassoClipboard.decode(data)
            return .inserted(try BoardLassoClipboard.insert(envelope, drawing: previous.drawing,
                items: previous.items, edges: previous.edges, context: context, canvasSize: previous.canvasSize, at: point))
        }
    }

    private func beginLassoClipboard(previous: LassoClipboardUndoState, message: String,
                                     operation: @escaping @Sendable () throws -> LassoClipboardWorkResult) {
        let token = UUID(), session = store.canvasSessionID, boardID = store.document.id, inkRevision = nativeInkRevision
        lassoWorkID = token; store.externalInteractionActive = true
        lassoStatus = message; lassoClipboardDiagnostic = "working"; updateLassoOverlay()
        let task = Task.detached(priority: .userInitiated) {
            try await BoardSavePreparation.withInkMemoryLease {
                try Task.checkCancellation()
                return try autoreleasepool { try operation() }
            }
        }
        lassoClipboardTask = task
        Task { [weak self] in
            let result = await task.result
            guard let self, self.lassoWorkID == token else { return }
            defer { self.finishLassoWork(token) }
            guard self.ownsCurrentSession, self.lassoEnabled, self.store.canvasSessionID == session,
                  self.store.document.id == boardID, self.nativeInkRevision == inkRevision,
                  self.canvas.drawing == previous.drawing, self.store.drawing == previous.drawing,
                  self.store.document.items == previous.items, self.store.document.edges == previous.edges else { return }
            switch result {
            case .success(.copied(let data, let text)):
                var item: [String: Any] = [BoardLassoClipboard.typeIdentifier: data]
                if !text.isEmpty { item["public.utf8-plain-text"] = text }
                UIPasteboard.general.setItems([item], options: [.localOnly: true])
                self.lassoClipboardDiagnostic = "copied,bytes:\(data.count),change:\(UIPasteboard.general.changeCount)"
                self.lassoStatus = String(localized: "已复制到剪贴板，未生成副本。")
            case .success(.inserted(let value)):
                self.registerLassoClipboardUndo(previous, added: value)
                self.store.document.edges = value.edges
                self.applyLassoResult(drawing: value.drawing, items: value.items, selection: value.selection)
                self.lassoClipboardDiagnostic = "inserted,strokes:\(value.selection.strokeIndices.count),items:\(value.selection.itemIDs.count)"
                self.lassoStatus = String(localized: "副本已选中，直接拖动或调整大小。")
            case .failure(let error):
                self.lassoClipboardDiagnostic = error is CancellationError ? "cancelled" : "failed"
                if !(error is CancellationError) { self.lassoStatus = error.localizedDescription }
            }
        }
    }

    private func registerLassoClipboardUndo(_ previous: LassoClipboardUndoState, added value: BoardLassoClipboard.Result) {
        let oldEdges = Set(previous.edges.map(\.id))
        registerLassoClipboardUndoStep(.init(expectedDrawing: value.drawing, replacementDrawing: previous.drawing,
            addedItems: value.items.filter { value.selection.itemIDs.contains($0.id) },
            addedEdges: value.edges.filter { !oldEdges.contains($0.id) }, adding: false,
            selection: previous.selection, inverseSelection: value.selection, canvasSize: previous.canvasSize))
    }

    private func registerLassoClipboardUndoStep(_ step: LassoClipboardUndoStep) {
        boardUndoManager?.registerUndo(withTarget: self) { host in
            guard host.ownsCurrentSession, !host.store.isBusy, !host.lassoWorkActive,
                  host.store.canEditBoardContents else { return }
            @MainActor func refuse() {
                host.lassoStatus = String(localized: "副本已被后续修改，无法安全撤销或重做；现有内容已保留。")
                host.updateLassoOverlay()
            }
            // Native edits normally unwind first through PencilKit's Undo stack.
            // Never replace unregistered or externally changed ink wholesale.
            guard host.canvas.drawing == step.expectedDrawing,
                  host.store.drawing == step.expectedDrawing else { refuse(); return }
            let addedIDs = Set(step.addedItems.map(\.id)), edgeIDs = Set(step.addedEdges.map(\.id))
            var items = host.store.document.items, edges = host.store.document.edges
            if step.adding {
                guard Set(items.map(\.id)).isDisjoint(with: addedIDs),
                      Set(edges.map(\.id)).isDisjoint(with: edgeIDs) else { refuse(); return }
                items.append(contentsOf: step.addedItems); edges.append(contentsOf: step.addedEdges)
            } else {
                guard Set(items.map(\.id)).count == items.count,
                      Set(edges.map(\.id)).count == edges.count else { refuse(); return }
                let itemByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
                let edgeByID = Dictionary(uniqueKeysWithValues: edges.map { ($0.id, $0) })
                guard step.addedItems.allSatisfy({ itemByID[$0.id] == $0 }),
                      step.addedEdges.allSatisfy({ edgeByID[$0.id] == $0 }),
                      !edges.contains(where: { !edgeIDs.contains($0.id) && (addedIDs.contains($0.from) || addedIDs.contains($0.to)) }),
                      !items.contains(where: { !addedIDs.contains($0.id) && $0.sourceCardID.map(addedIDs.contains) == true })
                else { refuse(); return }
                // Keep unrelated cards, text edits and connections made after copy.
                items.removeAll { addedIDs.contains($0.id) }; edges.removeAll { edgeIDs.contains($0.id) }
            }
            var candidate = host.store.document; candidate.items = items; candidate.edges = edges
            guard (try? candidate.validate()) != nil else { refuse(); return }
            var selection = BoardLassoSelection.Selection()
            if !step.selection.isEmpty,
               let checked = try? BoardLassoSelection.transform(snapshot: .init(drawing: step.replacementDrawing,
                    items: items, selection: step.selection, canvasSize: step.canvasSize)) { selection = checked.selection }
            host.registerLassoClipboardUndoStep(.init(expectedDrawing: step.replacementDrawing,
                replacementDrawing: step.expectedDrawing, addedItems: step.addedItems, addedEdges: step.addedEdges,
                adding: !step.adding, selection: step.inverseSelection, inverseSelection: step.selection, canvasSize: step.canvasSize))
            host.store.document.edges = edges
            host.applyLassoResult(drawing: step.replacementDrawing, items: items, selection: selection)
            if selection.isEmpty || !host.lassoEnabled { host.clearLassoSelection() }
        }
        boardUndoManager?.setActionName(String(localized: "复制圈选内容"))
    }

    private func finishLassoWork(_ token: UUID) {
        guard lassoWorkID == token else { return }
        lassoWorkID = nil; lassoSelectionTask = nil; lassoTransformTask = nil; lassoClipboardTask = nil
        if ownsCurrentSession { store.externalInteractionActive = lassoOverlay.isInteracting }
        updateLassoOverlay()
    }

    private func cancelLassoWork() {
        let hadWork = lassoWorkActive
        lassoWorkID = nil; lassoSelectionTask?.cancel(); lassoTransformTask?.cancel(); lassoClipboardTask?.cancel()
        lassoSelectionTask = nil; lassoTransformTask = nil; lassoClipboardTask = nil
        if hadWork, ownsCurrentSession { store.externalInteractionActive = lassoOverlay.isInteracting }
    }

    private func clearLassoSelection() {
        cancelLassoWork()
        lassoSnapshot = nil; lassoSelection = nil; lassoPolygon = []; lassoPreviewBounds = nil
        lassoSnapshotInkRevision = nil
        lassoTransformKind = nil; lassoStatus = ""
        lassoInputContext = "source:none"; lassoInputDiagnostic = "idle"
        if ownsCurrentSession, !store.selectedIDs.isEmpty { store.selectedIDs.removeAll() }
        updateLassoOverlay()
    }

    private func updateLassoOverlay() {
        updateCanvasAccessibilityValue()
        guard !lassoOverlay.isHidden else { return }
        let selection = lassoSelection
        let text = !lassoStatus.isEmpty ? lassoStatus : selection.map {
            String(format: String(localized: "拖动四角调整大小 · %d 笔 · %d 个模块"), $0.strokeIndices.count, $0.itemIDs.count)
        } ?? String(localized: "用 Pencil 圈住内容；手指移动白板")
        lassoOverlay.selectionAccessibilityValue = selection.map { "strokes=\($0.strokeIndices.count);items=\($0.itemIDs.count);bounds=\($0.bounds.minX),\($0.bounds.minY),\($0.bounds.width),\($0.bounds.height);outlinePoints=\($0.outline?.count ?? 0)" } ?? "none"
        lassoOverlay.update(selectionRect: selection.map { screenRect(for: $0.bounds) },
                            selectionOutline: screenOutline(for: selection?.outline), selectionText: text,
                            selectedTypes: lassoTypes, isEnabled: lassoEnabled && !lassoWorkActive, isWorking: lassoWorkActive)
    }

    private func beginLassoTransform(_ kind: BoardLassoOverlay.TransformKind, at point: CGPoint) {
        guard validLassoSnapshot, let selection = lassoSelection else { return }
        lassoTransformKind = kind; lassoTransformStart = worldPoint(point)
        lassoTransformScale = 1; lassoTransformTranslation = .zero; lassoPreviewBounds = selection.bounds
        let rect = selection.bounds
        switch kind {
        case .move: lassoTransformAnchor = nil
        case .resize(let corner):
            switch corner {
            case .topLeft: lassoTransformAnchor = CGPoint(x: rect.maxX, y: rect.maxY)
            case .topRight: lassoTransformAnchor = CGPoint(x: rect.minX, y: rect.maxY)
            case .bottomLeft: lassoTransformAnchor = CGPoint(x: rect.maxX, y: rect.minY)
            case .bottomRight: lassoTransformAnchor = CGPoint(x: rect.minX, y: rect.minY)
            }
        }
    }

    private func previewLassoTransform(at point: CGPoint) {
        // The immutable snapshot was checked at gesture begin and is checked
        // again before commit. Pointer previews only transform the outline, not a
        // deep equality walk over every item and every PencilKit stroke.
        guard lassoEnabled, !lassoWorkActive, lassoSnapshotInkRevision == nativeInkRevision,
              let kind = lassoTransformKind, let snapshot = lassoSnapshot else { return }
        let current = worldPoint(point), rect = snapshot.selection.bounds
        let preview: CGRect
        let matrix: CGAffineTransform
        switch kind {
        case .move:
            let raw = CGSize(width: current.x - lassoTransformStart.x, height: current.y - lassoTransformStart.y)
            lassoTransformTranslation = CGSize(width: min(max(raw.width, -rect.minX), snapshot.canvasSize.width - rect.maxX),
                height: min(max(raw.height, -rect.minY), snapshot.canvasSize.height - rect.maxY))
            matrix = CGAffineTransform(translationX: lassoTransformTranslation.width, y: lassoTransformTranslation.height)
            preview = rect.offsetBy(dx: lassoTransformTranslation.width, dy: lassoTransformTranslation.height)
        case .resize:
            guard let anchor = lassoTransformAnchor else { return }
            let start = CGVector(dx: lassoTransformStart.x - anchor.x, dy: lassoTransformStart.y - anchor.y)
            let divisor = start.dx * start.dx + start.dy * start.dy
            guard divisor > 0 else { return }
            let requested = ((current.x - anchor.x) * start.dx + (current.y - anchor.y) * start.dy) / divisor
            lassoTransformScale = min(20, max(0.05, requested))
            matrix = CGAffineTransform(a: lassoTransformScale, b: 0, c: 0, d: lassoTransformScale,
                tx: anchor.x * (1 - lassoTransformScale), ty: anchor.y * (1 - lassoTransformScale))
            preview = rect.applying(matrix)
        }
        lassoPreviewBounds = preview
        lassoOverlay.updatePreview(selectionRect: screenRect(for: preview),
            selectionOutline: screenOutline(for: BoardLassoSelection.transformedOutline(snapshot.selection.outline, using: matrix)),
            selectionText: String(format: String(localized: "%.0f%% · 松手应用，双指取消并缩放视图"), lassoTransformScale * 100))
    }

    private func finishLassoTransform(cancelled: Bool) {
        guard lassoTransformKind != nil else { return }
        defer { lassoTransformKind = nil; lassoPreviewBounds = nil; updateLassoOverlay() }
        guard !cancelled, validLassoSnapshot, let snapshot = lassoSnapshot else { return }
        guard lassoTransformScale != 1 || lassoTransformTranslation != .zero else { return }
        commitLassoTransform(snapshot: snapshot, translation: lassoTransformTranslation,
                             scale: lassoTransformScale, anchor: lassoTransformAnchor)
    }

    private func commitLassoTransform(snapshot: BoardLassoSelection.Snapshot, translation: CGSize = .zero,
                                      scale: CGFloat = 1, anchor: CGPoint? = nil) {
        guard !lassoWorkActive, validLassoSnapshot else { return }
        let token = UUID(), session = store.canvasSessionID, boardID = store.document.id, inkRevision = nativeInkRevision
        let memoryProbe = usesAppLassoResponder ? BoardLassoMemoryProbe.begin(
            scope: .init(session: session, boardID: boardID), selectedStrokes: snapshot.selection.strokeIndices.count,
            saveAlreadyActive: store.isSaving) : nil
        lassoWorkID = token; store.externalInteractionActive = true
        lassoStatus = String(localized: "正在应用圈选，可点完成取消…")
        updateLassoOverlay()
        BoardLassoMemoryProbe.mark(memoryProbe, .transformQueued, .point)
        BoardLassoMemoryProbe.mark(memoryProbe, .transformLease, .begin)
        let task = Task.detached(priority: .userInitiated) {
            try await BoardSavePreparation.withInkMemoryLease {
                BoardLassoMemoryProbe.mark(memoryProbe, .transformLease, .end)
                BoardLassoMemoryProbe.mark(memoryProbe, .transformWorker, .begin)
                defer { BoardLassoMemoryProbe.mark(memoryProbe, .transformWorker, .end) }
                try Task.checkCancellation()
                try BoardSavePreparation.checkDrawingMemory(snapshot.drawing)
                return try autoreleasepool {
                    try BoardLassoSelection.transform(snapshot: snapshot, translation: translation, scale: scale, anchor: anchor)
                }
            }
        }
        lassoTransformTask = task
        BoardLassoMemoryProbe.mark(memoryProbe, .transformAwait, .begin)
        Task { [weak self] in
            let result = await task.result
            BoardLassoMemoryProbe.mark(memoryProbe, .transformAwait, .end)
            guard let self, self.lassoWorkID == token else { return }
            defer {
                BoardLassoMemoryProbe.mark(memoryProbe, .lasso, .end)
                self.finishLassoWork(token)
            }
            guard self.ownsCurrentSession, self.store.canvasSessionID == session, self.store.document.id == boardID,
                  self.nativeInkRevision == inkRevision, self.validLassoSnapshot else { return }
            switch result {
            case .success(let value):
                BoardLassoMemoryProbe.mark(memoryProbe, .undoRegistration, .begin)
                self.registerLassoUndo(snapshot, expectedDrawing: value.drawing,
                    expectedItems: value.items, expectedSelection: value.selection)
                BoardLassoMemoryProbe.mark(memoryProbe, .undoRegistration, .end)
                BoardLassoMemoryProbe.mark(memoryProbe, .canvasCommit, .begin)
                self.applyLassoResult(drawing: value.drawing, items: value.items, selection: value.selection)
                BoardLassoMemoryProbe.mark(memoryProbe, .canvasCommit, .end)
            case .failure(let error):
                if !(error is CancellationError) { self.lassoStatus = error.localizedDescription }
            }
        }
    }

    private func applyLassoResult(drawing: PKDrawing, items: [BoardItem], selection: BoardLassoSelection.Selection) {
        // Register exactly one undo transaction for the whole mixed selection.
        // Programmatic PencilKit assignment must not add an independent ink-only undo.
        let undo = boardUndoManager
        let registrationWasEnabled = undo?.isUndoRegistrationEnabled
        let originalGroupingLevel = undo?.groupingLevel
        // This threshold selects an experiment path, never a stroke-count cap.
        let largeCustom = selection.strokeIndices.count >= 10_000 && usesAppLassoResponder
            && !store.usesPhoneInterface && !store.isPadReading && !store.reviewModeEnabled && store.mode == .ink
        if !largeCustom { lassoOffWindowOutcome = "standard.smallOrNative" }
        do {
            undo?.disableUndoRegistration()
            defer {
                undo?.enableUndoRegistration()
                lassoOffWindowRegistrationPreserved = undo?.isUndoRegistrationEnabled == registrationWasEnabled
                    && undo?.groupingLevel == originalGroupingLevel && boardUndoManager === undo
            }
            applyDrawing(drawing, brieflyDetachForLasso: largeCustom)
        }
        store.drawing = drawing
        store.document.items = items
        store.document.webInk = nil
        store.document.previewPNG = nil
        store.selectedIDs = selection.itemIDs
        lassoSelection = selection
        lassoSnapshot = BoardLassoSelection.Snapshot(drawing: drawing, items: items, selection: selection,
            canvasSize: CGSize(width: store.document.canvasWidth, height: store.document.canvasHeight))
        lassoSnapshotInkRevision = nativeInkRevision
        lassoPolygon = selection.outline ?? [CGPoint(x: selection.bounds.minX, y: selection.bounds.minY), CGPoint(x: selection.bounds.maxX, y: selection.bounds.minY),
            CGPoint(x: selection.bounds.maxX, y: selection.bounds.maxY), CGPoint(x: selection.bounds.minX, y: selection.bounds.maxY)]
        lassoStatus = ""
        store.refreshPreviews()
        backdrop.invalidatePreviews()
        refreshBackdrop()
        markChanged()
    }

    private func registerLassoUndo(_ previous: BoardLassoSelection.Snapshot,
                                   expectedDrawing: PKDrawing, expectedItems: [BoardItem],
                                   expectedSelection: BoardLassoSelection.Selection) {
        let boardID = store.document.id, session = store.canvasSessionID
        let selectedIDs = expectedSelection.itemIDs
        let expectedSelectedItems = expectedItems.filter { selectedIDs.contains($0.id) }
        boardUndoManager?.registerUndo(withTarget: self) { host in
            guard host.ownsCurrentSession, host.store.document.id == boardID,
                  host.store.canvasSessionID == session else { return }
            @MainActor func refuse(_ message: String) {
                host.lassoStatus = message
                host.updateLassoOverlay()
            }
            guard !host.store.isBusy, !host.lassoWorkActive, host.store.canEditBoardContents else {
                refuse(String(localized: "当前正在处理内容，暂时无法安全撤销或重做；现有内容已保留。"))
                return
            }
            // Programmatic imports/unpacking need not be part of PencilKit's
            // native undo stack. Never replace their newer ink with this older
            // full-drawing snapshot. Clipboard undo uses the same contract.
            guard host.canvas.drawing == expectedDrawing, host.store.drawing == expectedDrawing else {
                refuse(String(localized: "笔迹已被后续修改，暂时无法安全撤销或重做；现有内容已保留。"))
                return
            }
            let currentSelected = host.store.document.items.filter { selectedIDs.contains($0.id) }
            guard currentSelected.count == expectedSelectedItems.count,
                  currentSelected.count == selectedIDs.count,
                  Set(currentSelected.map(\.id)).count == currentSelected.count else {
                refuse(String(localized: "圈选内容已被后续修改，暂时无法安全撤销或重做；现有内容已保留。"))
                return
            }
            let currentByID = Dictionary(uniqueKeysWithValues: currentSelected.map { ($0.id, $0) })
            guard expectedSelectedItems.allSatisfy({ currentByID[$0.id] == $0 }) else {
                refuse(String(localized: "圈选内容已被后续修改，暂时无法安全撤销或重做；现有内容已保留。"))
                return
            }
            var current = BoardLassoSelection.Snapshot(drawing: host.canvas.drawing, items: host.store.document.items,
                selection: expectedSelection, canvasSize: previous.canvasSize)
            // A later selection may refer to completely different nodes. Redo
            // always uses this transaction's IDs and their current actual bounds.
            guard let currentResult = try? BoardLassoSelection.transform(snapshot: current) else {
                refuse(String(localized: "圈选内容已被后续修改，暂时无法安全撤销或重做；现有内容已保留。"))
                return
            }
            current.selection = currentResult.selection
            var restored = host.store.document.items
            for index in restored.indices where previous.selection.itemIDs.contains(restored[index].id) {
                guard let old = previous.items.first(where: { $0.id == restored[index].id }) else { continue }
                restored[index].x = old.x; restored[index].y = old.y
                restored[index].width = old.width; restored[index].height = old.height
                restored[index].inkData = old.inkData
                if let fontSize = old.style?.fontSize {
                    var style = restored[index].style ?? BoardItemStyle()
                    style.fontSize = fontSize
                    restored[index].style = style
                } else { restored[index].style?.fontSize = nil }
                if old.style == nil, restored[index].style == BoardItemStyle() { restored[index].style = nil }
                for linkIndex in restored[index].childBoards?.indices ?? 0..<0 {
                    let id = restored[index].childBoards![linkIndex].id
                    if let oldLink = old.childBoards?.first(where: { $0.id == id }) {
                        restored[index].childBoards![linkIndex].presentation = oldLink.presentation
                    }
                }
            }
            host.registerLassoUndo(current, expectedDrawing: previous.drawing,
                expectedItems: restored, expectedSelection: previous.selection)
            host.applyLassoResult(drawing: previous.drawing, items: restored, selection: previous.selection)
            if !host.lassoEnabled { host.clearLassoSelection() }
        }
        boardUndoManager?.setActionName(String(localized: "调整圈选内容"))
    }

    /// Pin-only undo never restores a whole board or an older drawing. The
    /// expected pin array/session guard preserves unrelated or newer changes.
    func registerPinEditUndo(previous: [BoardPin], expected: [BoardPin]) {
        let boardID = store.document.id, session = store.canvasSessionID
        boardUndoManager?.registerUndo(withTarget: self) { host in
            guard host.ownsCurrentSession, host.store.document.id == boardID,
                  host.store.canvasSessionID == session, host.store.canEditBoardContents,
                  !host.store.isBusy, !host.store.externalInteractionActive,
                  host.store.document.pins == expected else { return }
            host.registerPinEditUndo(previous: expected, expected: previous)
            host.store.document.pins = previous
            host.store.changed()
        }
        boardUndoManager?.setActionName(String(localized: "编辑定位点"))
    }

    @objc private func pinchLassoViewport(_ recognizer: UIPinchGestureRecognizer) {
        guard lassoEnabled else { return }
        let point = recognizer.location(in: self)
        switch recognizer.state {
        case .began:
            lassoOverlay.cancelInteraction()
            pinchStartZoom = canvas.zoomScale; pinchAnchorWorld = worldPoint(point)
            canvas.panGestureRecognizer.isEnabled = false
            store.externalInteractionActive = true
        case .changed:
            applyingViewport = true
            canvas.setZoomScale(min(canvas.maximumZoomScale, max(canvas.minimumZoomScale, pinchStartZoom * recognizer.scale)), animated: false)
            setClampedOffset(CGPoint(x: pinchAnchorWorld.x * canvas.zoomScale - point.x,
                                    y: pinchAnchorWorld.y * canvas.zoomScale - point.y))
            applyingViewport = false
            viewportDidChange(userInitiated: true)
        case .ended, .cancelled, .failed:
            store.externalInteractionActive = false
            canvas.panGestureRecognizer.isEnabled = true
            backdrop.finishViewportInteraction()
            updateLassoOverlay()
        default: break
        }
    }

    func tearDown() {
        guard !isTornDown else { return }
        cancelLassoWork()
        finishWritingAidCommit(error: BoardWritingAidFailure.changedSession.localizedDescription, outcome: "tearDown")
        writingAidInputActive = false; updateWritingAidInteractionLease()
        cancelPencilStraightening()
        cancelHighlighterUnderlay()
        NotificationCenter.default.removeObserver(self, name: .boardPencilAssistSettingsChanged, object: nil)
        pencilHoldLine.canObserve = nil; pencilHoldLine.onBegin = nil
        pencilHoldLine.onPreview = nil; pencilHoldLine.onFinish = nil; pencilHoldLine.onObservation = nil
        removeGestureRecognizer(pencilHoldLine)
        heldLinePreview.removeFromSuperlayer()
        backdrop.inkInteractionProbe = nil
        writingAidOverlay.detachPencilInput()
        writingAidOverlay.onCommitDrawing = nil; writingAidOverlay.onCreateText = nil
        writingAidOverlay.onInputActivity = nil; writingAidOverlay.onCancelDrawingCommit = nil
        writingAidOverlay.onTapesChange = nil; writingAidOverlay.onDraftChanged = nil; writingAidOverlay.onStatus = nil
        lassoOverlay.detachPencilInput()
        lassoOverlay.isHidden = true
        lassoViewportPinch.isEnabled = false
        if ownsCurrentSession { store.externalInteractionActive = false }
        pendingPickerPersistence?.cancel()
        pendingPickerPersistence = nil
        persistPickerState()
        isTornDown = true
        dockedPalette.isHidden = true
        dockedPalette.onSelect = nil
        dockedPalette.onManage = nil
        dockedPalette.onSettings = nil
        inlineTextSelection?.tearDown()
        if store.readingCanvas === self {
            store.readAloud.onHighlight = nil
            store.readingCanvas = nil
        }
        backdrop.onRenderedContentChange = nil
        picker.setVisible(false, forFirstResponder: canvas)
        picker.removeObserver(canvas)
        picker.removeObserver(self)
        canvas.drawingGestureRecognizer.removeTarget(self, action: #selector(drawingGestureStateDidChange(_:)))
        readingVideoTap.isEnabled = false
        readingVideoTap.removeTarget(self, action: #selector(openReadingVideo(_:)))
        canvas.removeGestureRecognizer(readingVideoTap)
        if let pencilInteraction { removeInteraction(pencilInteraction); self.pencilInteraction = nil }
        pencilArc.isHidden = true
        pencilArc.onSelect = nil; pencilArc.onEdit = nil; pencilArc.onEditTool = nil; pencilArc.onManage = nil; pencilArc.onClose = nil
        dockedPalette.onEdit = nil; dockedPalette.onShowArc = nil
        canvas.delegate = nil
        canvas.diagnosticValue = nil
        boardUndoManager?.removeAllActions(withTarget: self)
        canvas.resignFirstResponder()
        if isFirstResponder { resignFirstResponder() }
        capturedCanvasUndoManager = nil
        interactionSurface.onPan = nil
        interactionSurface.onPinch = nil
        interactionSurface.onTap = nil
        interactionSurface.onDoubleTap = nil
        onEditItem = nil
        reviewSurface.onStroke = nil
        reviewSurface.onErase = nil
        reviewSurface.onNavigatePan = nil
        reviewSurface.onNavigatePinch = nil
        videoOverlay.tearDown()
        webOverlay.tearDown()
        childOverlay.tearDown()
        if Self.activePaletteHost === self { Self.activePaletteHost = nil }
        backdrop.releasePreviews()
    }
}

private struct BoardTextSelectionInkRenderRequest {
    let drawing: PKDrawing
    let background: UIImage
    let size: CGSize
    let imageScale: CGFloat
    let worldRect: CGRect
    let inkScale: CGFloat
}

/// One immutable native snapshot at a time. Cancellation rejects obsolete work
/// before rasterization and before delivery without mutating the live canvas.
private final class BoardTextSelectionInkRenderer: @unchecked Sendable {
    static let shared = BoardTextSelectionInkRenderer()
    private let queue = DispatchQueue(label: "InkSpace.text-selection-ink", qos: .utility)

    func image(_ request: BoardTextSelectionInkRenderRequest, token: BoardPreviewCancellation) async -> UIImage? {
        await withCheckedContinuation { continuation in
            queue.async {
                let result: UIImage? = autoreleasepool {
                    guard !token.isCancelled else { return nil }
                    var paperInk: UIImage?
                    UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                        paperInk = request.drawing.image(from: request.worldRect, scale: request.inkScale)
                    }
                    guard let ink = paperInk else { return nil }
                    guard !token.isCancelled else { return nil }
                    let format = UIGraphicsImageRendererFormat()
                    format.scale = request.imageScale
                    format.opaque = true
                    let image = UIGraphicsImageRenderer(size: request.size, format: format).image { _ in
                        let rect = CGRect(origin: .zero, size: request.size)
                        request.background.draw(in: rect)
                        ink.draw(in: rect)
                    }
                    return token.isCancelled ? nil : image
                }
                continuation.resume(returning: result)
            }
        }
    }
}

extension BoardItem {
    var canvasWorldRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

extension CGRect {
    var isFiniteCanvasRect: Bool {
        !isNull && !isInfinite && origin.x.isFinite && origin.y.isFinite && width.isFinite && height.isFinite
    }
}

/// Screen-sized, non-interactive vector preview. Its extent is the complete
/// source union, including offscreen ink and attached content. No giant bitmap,
/// duplicated PencilKit drawing, or document change is made while navigating.
@MainActor private final class BoardMergePlacementOverlay: UIView {
    private let outline = CAShapeLayer()
    private let anchor = CAShapeLayer()
    private let caption = UILabel()
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false; clipsToBounds = true
        accessibilityIdentifier = "board.merge.placement.preview"
        isAccessibilityElement = true
        outline.lineWidth = 2; outline.lineDashPattern = [8,5]
        layer.addSublayer(outline); layer.addSublayer(anchor)
        caption.font = .preferredFont(forTextStyle: .caption1)
        caption.numberOfLines = 2; caption.textAlignment = .center
        caption.backgroundColor = .secondarySystemBackground
        caption.layer.cornerRadius = 8; caption.clipsToBounds = true
        addSubview(caption); isHidden = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func synchronize(session: BoardMergePlacementSession?, zoom: CGFloat, offset: CGPoint) {
        guard let session, zoom.isFinite, zoom > 0 else { isHidden = true; return }
        isHidden = false
        let world = session.bounds
        let rect = CGRect(x: world.minX * zoom - offset.x, y: world.minY * zoom - offset.y,
                          width: max(1, world.width * zoom), height: max(1, world.height * zoom))
        let color: UIColor = session.fitsCanvas ? .systemTeal : .systemRed
        CATransaction.begin(); CATransaction.setDisableActions(true)
        outline.path = UIBezierPath(rect: rect).cgPath
        outline.strokeColor = color.cgColor; outline.fillColor = color.withAlphaComponent(0.10).cgColor
        anchor.path = UIBezierPath(ovalIn: CGRect(x: rect.minX-7,y:rect.minY-7,width:14,height:14)).cgPath
        anchor.fillColor = color.cgColor
        CATransaction.commit()
        let chosen = session.position != nil
        caption.text = chosen ? String(localized: "整块合并范围 · 再点可移动\n确认前不写入") : String(localized: "整块合并范围\n点击设定左上角")
        caption.textColor = color
        let visible = rect.intersection(bounds.insetBy(dx:8,dy:8))
        caption.isHidden = visible.isNull || visible.width < 80 || visible.height < 28
        if !caption.isHidden {
            caption.frame = CGRect(x:visible.minX+4,y:visible.minY+4,
                width:min(240,max(72,visible.width-8)),height:min(48,max(24,visible.height-8)))
        }
        accessibilityLabel = chosen ? String(localized: "已选合并位置，确认前可再次点选") : String(localized: "整块合并范围，尚未选择位置")
        accessibilityValue = "selected=\(chosen);valid=\(session.fitsCanvas);bounds=\(world.minX),\(world.minY),\(world.width),\(world.height)"
    }
}
