import SwiftUI
import Observation
import PencilKit
import UIKit

enum BoardMode: String, CaseIterable { case ink, arrange, frame, place, paper }
enum BoardPrintTool: Equatable { case select, place, region, exportRegion }

private enum BoardHistoryOpenError: LocalizedError {
    case wrongVault, wrongBoard
    var errorDescription: String? {
        switch self {
        case .wrongVault: String(localized: "所选文件夹属于另一个仓库，原白板和授权已保留。")
        case .wrongBoard: String(localized: "此路径的白板与历史记录不一致，未切换或覆盖。请确认选择了原来的仓库。")
        }
    }
}

extension SavedPenKind {
    var inkType: PKInkingTool.InkType {
        switch self {
        case .pen: .pen
        case .fountainPen: .fountainPen
        case .monoline: .monoline
        case .pencil: .pencil
        case .marker: .marker
        case .watercolor: .watercolor
        case .crayon: .crayon
        case .reed:
            if #available(iOS 26.0, macOS 26.0, *) { .reed } else { .fountainPen }
        }
    }
    var minimumWidth: Double { Double(inkType.validWidthRange.lowerBound) }
    var maximumWidth: Double {
        // PencilKit's pen/pencil/marker clamp out-of-range widths. Monoline
        // accepts wider native strokes, including through the native picker.
        self == .monoline ? 64 : Double(inkType.validWidthRange.upperBound)
    }
    var defaultWidth: Double { Double(inkType.defaultWidth) }
}

struct CanvasCommand {
    var id = UUID()
    var action: Action
    enum Action {
        case fitAll, zoomIn, zoomOut, undo, redo, toggleRuler, showPalette, capture
        case jump(CGPoint, zoom: CGFloat)
        case restoreViewport(CGPoint, zoom: CGFloat)
        case fitRegion(CGRect)
    }
}

/// Only the fields owned by a text/formula editor. Undo must not restore an
/// old whole item over a later move, resize, source link or unrelated ink.
struct BoardTextEditContent: Equatable {
    var title: String
    var text: String?
    var textFormat: String?
    var richTextHTML: String?
    var url: String?

    init(_ item: BoardItem) {
        title = item.title; text = item.text; textFormat = item.textFormat
        richTextHTML = item.richTextHTML; url = item.url
    }

    func apply(to item: inout BoardItem) {
        item.title = title; item.text = text; item.textFormat = textFormat
        item.richTextHTML = richTextHTML; item.url = url
    }
}

/// Explicit pen choices have their own channel so a viewport command cannot replace them.
struct SavedPenSelectionRequest: Equatable {
    let id = UUID()
    let penID: UUID
}

@MainActor @Observable
final class BoardStore {
    var document = BoardDocument()
    var canvasSessionID = UUID() {
        didSet { if oldValue != canvasSessionID {
            BoardLassoMemoryProbe.retire(session: oldValue)
            readAloud.stop()
        } }
    }
    /// Embedded sessions never replace the app's remembered vault/board.
    var isEmbeddedSession = false
    @ObservationIgnored weak var embeddingRoot: BoardStore?
    @ObservationIgnored var childSessions: [String: BoardStore] = [:]
    @ObservationIgnored var childLoadTasks: [String: Task<BoardStore?, Never>] = [:]
    @ObservationIgnored private var lastChildRefresh = Date.distantPast
    @ObservationIgnored private var refreshingChildren = false
    @ObservationIgnored var childCanvasLeases = Set<UUID>()
    var childNavigationHistory: [String] = []
    var childSessionRevision = 0
    var childOperationInProgress = false
    var childRoot: BoardStore { embeddingRoot ?? self }
    var childSessionsHavePendingEdits: Bool {
        !isEmbeddedSession && childSessions.values.contains {
            $0.isDirty || $0.isSaving || $0.externalInteractionActive || $0.readingCanvas?.snapshotInteractionActive == true
        }
    }
    var drawing = PKDrawing() {
        didSet {
            nativeDrawingRevision &+= 1
            preparedNativeDrawing = nil
        }
    }
    /// Bytes are shared Data values, not another retained PKDrawing. Only the
    /// exact native setter revision/session/board can reuse a successful archive.
    @ObservationIgnored private var nativeDrawingRevision: UInt64 = 0
    @ObservationIgnored private var preparedNativeDrawing: (revision: UInt64, session: UUID, boardID: UUID, bytes: Data)?
    @ObservationIgnored private var nativeDrawingPreparation: (id: UUID, revision: UInt64, session: UUID, boardID: UUID, task: Task<Data, Error>)?
    var selectedIDs: Set<UUID> = []
    var mode: BoardMode = .ink {
        didSet {
            if isPadReading && mode != .ink { mode = .ink }
            // Phone placement only chooses an anchor for a separate review.
            if usesPhoneInterface && mode != .ink && mode != .place { mode = .ink }
        }
    }
    // Presentation-only input policy. Opening any board on a phone returns to
    // reading; it never changes the persisted schema or the iPad Pencil policy.
    let usesPhoneInterface = UIDevice.current.userInterfaceIdiom == .phone
    /// Writing keeps Pencil input primary; auxiliary recognition remains available
    /// on demand. This device preference never enters a board or resets pen settings.
    var writingPriorityEnabled = UserDefaults.standard.object(forKey: "InkSpace.writingPriority.v1") as? Bool ?? true {
        didSet {
            guard oldValue != writingPriorityEnabled else { return }
            UserDefaults.standard.set(writingPriorityEnabled, forKey: "InkSpace.writingPriority.v1")
        }
    }
    private(set) var padReadingEnabled = UIDevice.current.userInterfaceIdiom == .pad
    var isPadReading: Bool { !usesPhoneInterface && padReadingEnabled }
    /// Permanent board changes belong to the iPad editor. Phone annotations
    /// use their own review/PDF sidecars and never enable this capability.
    var canEditBoardContents: Bool { !usesPhoneInterface && !isPadReading && !reviewModeEnabled }
    @ObservationIgnored weak var readingCanvas: BoardCanvasHost?
    /// Ephemeral UI state only; recognized text never enters the board file.
    var readingTextSelectionStatus = ""
    let readAloud = BoardReadAloudController()
    let writingAids = BoardWritingAidController()
    var isReadAloudActive: Bool { readAloud.isPreparing || readAloud.isSpeaking || readAloud.isPaused }
    func beginBoardReadAloud() { readingCanvas?.beginReadAloud() }
    func requestReadingTextSelection() {
        status = readingCanvas?.revealReadingText() ?? String(localized: "白板画面尚未准备好，请稍后再试。")
    }
    func copyReadingTextSelection() {
        status = readingCanvas?.copyReadingText() == true
            ? String(localized: "已复制所选文字")
            : String(localized: "请先长按白板文字并调整选区。")
    }
    @discardableResult func beginPadReading() async -> Bool {
        guard !usesPhoneInterface else { return false }
        if isPadReading { return true }
        guard await flushChildSessions() else { return false }
        guard !isBusy, !reviewModeEnabled, !externalInteractionActive,
              readingCanvas?.prepareForReading() != false else {
            status = String(localized: "请先抬起笔或结束拖动，再切换阅读。"); return false
        }
        let session = canvasSessionID
        busyOperationTitle = String(localized: "正在保存并准备阅读…")
        isBusy = true; defer { isBusy = false; busyOperationTitle = nil }
        guard await flushEdits(), canvasSessionID == session, !Task.isCancelled else { return false }
        guard readingCanvas?.prepareForReading() != false else { return false }
        selectedIDs = []; selectedPrintFrameID = nil; insertionPoint = nil; command = nil
        padReadingEnabled = true; mode = .ink
        synchronizeChildInputPolicy()
        status = String(localized: "只读阅读：单指移动、双指缩放；笔和手指都不会修改白板。")
        return true
    }
    func beginPadEditing() {
        guard !usesPhoneInterface, !isBusy, !externalInteractionActive else { return }
        padReadingEnabled = false; mode = .ink
        synchronizeChildInputPolicy()
        status = String(localized: "编辑已开启，可使用 Apple Pencil 书写与整理。")
    }
    /// A modal import temporarily permits its own node insertion. Restoring input
    /// policy must not depend on a successful save or discard pending nodes.
    func restoreReadingAfterStudyImport(session: UUID) {
        guard !usesPhoneInterface, canvasSessionID == session else { return }
        selectedIDs = []; selectedPrintFrameID = nil; insertionPoint = nil; command = nil
        padReadingEnabled = true; mode = .ink
        synchronizeChildInputPolicy()
    }
    var phoneMarkupEnabled = false
    var phonePen = SavedPen(name: "", kind: .pen, width: 3)
    var phoneEraserEnabled = false
    let reviews = BoardReviewStore()
    var reviewModeEnabled = false

    func attachReviews() async {
        await reviews.attach(root: vaultURL, path: boardURL.flatMap { relativePath(for: $0) }, boardID: document.id, session: canvasSessionID)
    }
    func beginTemporaryReview(at point: CGPoint? = nil) async {
        guard !isBusy, !externalInteractionActive, boardURL != nil else { status = String(localized: "请先保存白板，再添加待修改批注"); return }
        let session = canvasSessionID, boardID = document.id
        guard await reviews.flush(), canvasSessionID == session, !Task.isCancelled else { return }
        // Entering sidecar review from reading must not retry source-PDF writes.
        // beginPadReading already flushed edits before enabling the read-only policy.
        if !isPadReading {
            guard await save(), canvasSessionID == session, document.id == boardID, !Task.isCancelled else { return }
        }
        await attachReviews()
        guard canvasSessionID == session, document.id == boardID, !Task.isCancelled,
              reviews.isBound(boardID: boardID, session: session) else { return }
        phoneMarkupEnabled = false; mode = .ink; reviewModeEnabled = true; reviews.overlaysVisible = true
        if let point { reviews.compose(points: [point], board: document) }
        else { reviews.captureEnabled = true }
    }
    func endTemporaryReview() async {
        guard await reviews.flush() else { return }
        reviews.discardDraft(); reviewModeEnabled = false
    }
    func jumpToReview(_ review: BoardReview) {
        guard reviews.isBound(boardID: document.id, session: canvasSessionID), reviews.records.contains(where: { $0.id == review.id }) else { return }
        reviews.selectedID = review.id; reviews.overlaysVisible = true
        let rect = reviews.rect(for: review, items: document.items)
        command = CanvasCommand(action: .restoreViewport(CGPoint(x: rect.midX,y:rect.midY), zoom: max(zoom,0.7)))
    }


    func beginPhoneReading() {
        guard usesPhoneInterface else { return }
        phoneMarkupEnabled = false
        mode = .ink
    }

    func beginPhoneMarkup() {
        guard usesPhoneInterface, !isBusy else { return }
        phoneMarkupEnabled = false
        mode = .ink
    }
    var printTool: BoardPrintTool = .select
    var selectedPrintFrameID: UUID?
    var printOrientation: BoardPrintOrientation = .portrait
    var printScale: Double = 1
    var showsPrintFrames = true
    var capturedPrintRegion: CGRect?
    var printRegionRequest = UUID()
    var capturedRegionForExport = false
    let backups = BoardBackupController()
    let backgroundRefresh = BoardBackgroundRefreshController()
    var recentBrowse: RecentBrowseStore { .shared }
    @ObservationIgnored private var windowPersistence: WorkspaceWindowPersistence?
    @ObservationIgnored private var windowNavigationAttempt: WorkspaceWindowRequest?
    @ObservationIgnored private(set) var initialWindowNavigationRequest: WorkspaceWindowRequest?
    var revealWorkspaceRequest = UUID()
    var pendingWindowRecent: RecentBrowseEntry?
    @ObservationIgnored var workspaceWindowID: String?
    @ObservationIgnored var focusWorkspaceWindow: ((String) -> Void)?

    func configureWindowPersistence(id: String, allowsLegacyRestore: Bool,
                                    initialBookmark: Data?, initialBoardPath: String?,
                                    hasRecentFallback: Bool = false, defaults: UserDefaults = .standard) {
        guard windowPersistence == nil, vaultURL == nil else { return }
        workspaceWindowID = id
        let persistence = WorkspaceWindowPersistence(id: id, allowsLegacyRestore: allowsLegacyRestore, defaults: defaults)
        windowPersistence = persistence
        do {
            if let pending = try persistence.pendingNavigation(), let entry = pending.recentEntry {
                // Revalidate the bookmarked folder's identity before preparing
                // a pending target. Old binding payloads are never reissued.
                let root = try recentBrowse.resolveRoot(for: entry)
                let access = root.startAccessingSecurityScopedResource()
                defer { if access { root.stopAccessingSecurityScopedResource() } }
                let bookmark = try root.bookmarkData(options: .minimalBookmark,
                    includingResourceValuesForKeys: nil, relativeTo: nil)
                persistence.seed(bookmark: bookmark,
                    boardPath: entry.kind == .board ? entry.relativePath : nil, replacingExisting: true)
                windowNavigationAttempt = pending
                initialWindowNavigationRequest = pending
            } else if !hasRecentFallback, let initialBookmark {
                persistence.seed(bookmark: initialBookmark, boardPath: initialBoardPath)
            }
        } catch { status = error.localizedDescription }
    }

    func prepareWindowNavigation(_ request: WorkspaceWindowRequest) {
        guard request.windowID == workspaceWindowID, let persistence = windowPersistence else { return }
        do {
            guard let pending = try persistence.pendingNavigation(),
                  pending.navigationToken == request.navigationToken else { return }
            windowNavigationAttempt = pending
        } catch { status = error.localizedDescription }
    }

    /// Explicitly choosing another ordinary route supersedes a failed request.
    /// A read failure alone never calls this, so its complete target can retry.
    func cancelPendingWindowNavigation() {
        guard let persistence = windowPersistence else { return }
        do {
            if let token = try persistence.pendingNavigation()?.navigationToken {
                _ = try persistence.consumeNavigation(token: token)
            }
            windowNavigationAttempt = nil
        } catch { status = error.localizedDescription }
    }

    private func finishWindowNavigationAfterSuccessfulOpen(kind: RecentBrowseKind, relativePath: String) {
        guard let attempt = windowNavigationAttempt, let entry = attempt.recentEntry,
              let token = attempt.navigationToken, let persistence = windowPersistence, let root = vaultURL else { return }
        let expectedRoot = try? recentBrowse.resolveRoot(for: entry)
        let sameRoot = expectedRoot?.standardizedFileURL.resolvingSymlinksInPath()
            == root.standardizedFileURL.resolvingSymlinksInPath()
        let matches = sameRoot && entry.kind == kind && entry.relativePath == relativePath
        // An older asynchronous open may finish after a newer request was
        // armed. Only its exact target can consume the pending receipt.
        guard matches else { return }
        do {
            _ = try persistence.consumeNavigation(token: token)
            windowNavigationAttempt = nil
        } catch { status = error.localizedDescription }
    }

    private func supersedeWindowNavigationForBoardOpen(path: String, root: URL) {
        guard let entry = windowNavigationAttempt?.recentEntry else { return }
        let expectedRoot = try? recentBrowse.resolveRoot(for: entry)
        if entry.kind != .board || entry.relativePath != path
            || expectedRoot?.standardizedFileURL.resolvingSymlinksInPath()
                != root.standardizedFileURL.resolvingSymlinksInPath() {
            cancelPendingWindowNavigation()
        }
    }

    func windowFocusRequest() -> WorkspaceWindowRequest? {
        guard let workspaceWindowID, let bookmark = windowPersistence?.location?.bookmark else { return nil }
        return WorkspaceWindowRequest(windowID: workspaceWindowID, folderBookmark: bookmark,
            relativePath: boardURL.flatMap { relativePath(for: $0) }, chooseFolder: false)
    }

    var hasRememberedWindowLocation: Bool {
        windowPersistence?.location != nil || (windowPersistence == nil && UserDefaults.standard.data(forKey: "vaultBookmark") != nil)
    }
    private func rememberVault(_ bookmark: Data) {
        guard !isEmbeddedSession else { return }
        if let windowPersistence { windowPersistence.rememberVault(bookmark) }
        else {
            UserDefaults.standard.set(bookmark, forKey: "vaultBookmark")
            UserDefaults.standard.removeObject(forKey: "lastBoardPath")
        }
    }
    private func rememberBoard(_ path: String?) {
        guard !isEmbeddedSession else { return }
        if let windowPersistence { windowPersistence.rememberBoard(path) }
        else { UserDefaults.standard.set(path, forKey: "lastBoardPath") }
    }
    func recordRecentBrowse(kind: RecentBrowseKind, relativePath: String = "", title: String) {
        guard !isEmbeddedSession, let vaultURL else { return }
        _ = try? recentBrowse.recordSuccessfulOpen(kind: kind, rootURL: vaultURL,
            relativePath: relativePath, title: title)
        finishWindowNavigationAfterSuccessfulOpen(kind: kind, relativePath: relativePath)
    }
    @ObservationIgnored private var recentHistoryImported = false
    @ObservationIgnored private var importingRecentHistory = false
    func importCatalogRecentHistory() async {
        guard !isEmbeddedSession, !recentHistoryImported, !importingRecentHistory else { return }
        importingRecentHistory = true
        defer { importingRecentHistory = false }
        let entries = boardCatalog.entries.filter { $0.lastOpenedAt != nil && !$0.isMissing }
            .sorted { ($0.lastOpenedAt ?? .distantPast) > ($1.lastOpenedAt ?? .distantPast) }.prefix(50)
        for entry in entries {
            guard !Task.isCancelled else { return }
            do {
                let root = try boardCatalog.authorizedURL(for: entry.vaultID)
                let access = root.startAccessingSecurityScopedResource()
                defer { if access { root.stopAccessingSecurityScopedResource() } }
                _ = try recentBrowse.recordHistoricalOpen(kind: .board, rootURL: root,
                    relativePath: entry.relativePath, title: entry.title, openedAt: entry.lastOpenedAt ?? .distantPast)
            } catch { /* Retain unavailable history in its original catalogue. */ }
            await Task.yield()
        }
        recentHistoryImported = recentBrowse.storageIssue == nil
    }

    private func focusPeerIfAlreadyOpen(_ url: URL) -> Bool {
        guard !isEmbeddedSession, let id = WorkspaceSceneRegistry.shared.peerWindow(forBoard: url, excluding: self) else { return false }
        focusWorkspaceWindow?(id)
        status = String(localized: "这份白板已在另一个窗口打开，已切换到该窗口。")
        return true
    }
    let boardCatalog = BoardCatalogStore(onFailure: { _ in
        DiagnosticsCenter.shared.record(code: .catalogFailed, operation: .organizeBoards)
    })
    var command: CanvasCommand?
    var viewportCenter = CGPoint(x: 500_000, y: 500_000)
    var zoom: CGFloat = 1
    var canJumpToLastInk: Bool {
        !drawing.strokes.isEmpty || document.items.contains { $0.kind == .inkGroup && $0.inkData != nil }
            || (document.drawing == nil && (document.lastInkLocation != nil || !(document.webInk?.strokes.isEmpty ?? true)))
    }

    private var canNavigateBoard: Bool {
        !isBusy && !externalInteractionActive && readingCanvas?.snapshotInteractionActive != true
    }

    @discardableResult
    func locateItem(_ id: UUID) -> Bool {
        guard canNavigateBoard else { status = String(localized: "请先结束书写或拖动，再定位。"); return false }
        guard let item = document.items.first(where: { $0.id == id }) else {
            status = String(localized: "该资料已不在当前白板上。"); return false
        }
        command = CanvasCommand(action: .fitRegion(item.canvasWorldRect))
        status = String(localized: "已定位资料") + "：" + item.title
        return true
    }

    func jumpToLastInk() {
        guard canNavigateBoard else { status = String(localized: "请先结束书写或拖动，再定位。"); return }
        var location = BoardInkLocator.location(drawing: drawing, items: document.items, canvasSize: document.canvasWidth)
        var usedPreview = false
        // An authoritative empty native drawing means the last stroke was erased.
        // Never resurrect an old cached position after deletion.
        if location == nil, document.drawing == nil, drawing.strokes.isEmpty,
           !document.items.contains(where: { $0.kind == .inkGroup && $0.inkData != nil }) {
            location = document.lastInkLocation
            if location == nil {
                location = BoardInkLocator.webLocation(document.webInk, canvasSize: document.canvasWidth)
                usedPreview = location != nil
            }
        }
        guard let location else { status = String(localized: "当前白板还没有可定位的笔迹。"); return }
        command = CanvasCommand(action: .fitRegion(location.rect))
        status = usedPreview ? String(localized: "已定位旧版预览中最后一笔；该格式没有书写时间记录。") : String(localized: "已回到最后一笔。")
    }
    var status = String(localized: "请选择 iCloud 或本机资料文件夹")
    var vaultURL: URL?
    var library: DocumentLibrary?
    var boardURL: URL?
    var boardFilesWarning: String?
    var isDirty = false
    var isSaving = false
    var obsidianNoteURL: URL?
    var pdfSyncStatus = ""
    @ObservationIgnored private var needsLinkRetry = false
    var lastSnapshot: UIImage?
    var snapshotToken = UUID()
    var imageRevision = 0
    var previewEpoch = 0
    var pendingOpenPath: String?
    var insertionPoint: CGPoint? = nil
    var pendingNewBoardDirectory: String? = nil
    var pendingNewBoardSource: String?
    var pendingNewBoardVault: String?
    var newBoardRequestID = UUID()
    var isBusy = false
    private(set) var busyOperationTitle: String?
    private(set) var savedPens: [SavedPen] = []
    private(set) var selectedSavedPenID: UUID?
    private(set) var savedPenSelectionRequest: SavedPenSelectionRequest?
    private(set) var nativePaletteEntries: [NativePaletteEntry] = NativePaletteEntry.utilities
    var nativePaletteEditorRequestID: UUID?
    var nativePenEditorRequest: SavedPenSelectionRequest?

    @ObservationIgnored private let io = VaultFileIO()
    @ObservationIgnored private let readLoader = BoardReadLoader()
    @ObservationIgnored private var refreshInProgress = false
    private struct LinkedPreviewIdentity: Equatable {
        let session: UUID
        let boardID: UUID
        let boardURL: URL
        let vaultURL: URL
    }
    @ObservationIgnored private var deferredLinkedPreviewRefresh: LinkedPreviewIdentity?
    private(set) var isRefreshingBoard = false
    var externalRefreshStatus = ""
    var externalRefreshPaused = false
    var externalInteractionActive = false
    var canRefreshForLifecycle: Bool {
        boardURL != nil && vaultURL != nil && !refreshInProgress && !isBusy && !isSaving && !isDirty && !childSessionsHavePendingEdits
            && !externalRefreshPaused && !externalInteractionActive && mode == .ink
            && !reviewModeEnabled && reviews.draft == nil && !reviews.isWriting
            && readingCanvas?.snapshotInteractionActive != true
            && !isReadAloudActive
    }
    @ObservationIgnored private let pdfWriteback = PDFAnnotationWritebackService()
    @ObservationIgnored var fileManagementInProgress = false
    @ObservationIgnored private var diskFingerprint: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var autosaveTask: Task<Void, Never>?
    @ObservationIgnored private var autosaveFirstChange: ContinuousClock.Instant?
    @ObservationIgnored private var autosaveFailureCount = 0
#if INKSPACE_AUTOSAVE_TESTING
    /// Deterministic suspension at the real native write boundary, absent in release builds.
    @ObservationIgnored var beforeNativeSave: (() async -> Void)?
#endif
    @ObservationIgnored private var backgroundSaveTask: Task<Void, Never>?
    @ObservationIgnored private var backgroundSaveID: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var backgroundSaveToken: UUID?
    @ObservationIgnored private var securityAccess = false
    @ObservationIgnored private var securityScopedRoot: URL?
    @ObservationIgnored private let thumbnails = NSCache<NSString, UIImage>()
    @ObservationIgnored private var requestedThumbnails = Set<String>()
    @ObservationIgnored private var failedThumbnails = Set<String>()
    @ObservationIgnored private let formulaRenderer = FormulaRenderer()
    @ObservationIgnored private let writerID = UUID()

    init() {
        thumbnails.totalCostLimit = 48 * 1024 * 1024
        thumbnails.countLimit = 32
        do {
            let settings = try SavedPenSettings.load()
            savedPens = settings.pens.map(normalizedSavedPen)
            selectedSavedPenID = settings.selectedID
            nativePaletteEntries = NativePaletteSettings.migrated(penIDs: savedPens.map(\.id)).entries
            do {
                nativePaletteEntries = try NativePaletteSettings.load(penIDs: savedPens.map(\.id)).entries
            } catch {
                // Keep the unreadable bytes for recovery. The fallback is only in
                // memory until the user next changes a pen or palette setting.
                let defaults = UserDefaults.standard
                if defaults.data(forKey: NativePaletteSettings.unreadableBackupKey) == nil,
                   let data = defaults.data(forKey: NativePaletteSettings.defaultsKey) {
                    defaults.set(data, forKey: NativePaletteSettings.unreadableBackupKey)
                }
                DiagnosticsCenter.shared.record(code: .settingsFailed, operation: .settings, error: error)
                status = String(localized: "原生笔栏设置读取失败：\(error.localizedDescription)")
            }
        } catch {
            DiagnosticsCenter.shared.record(code: .settingsFailed, operation: .settings, error: error)
            status = String(localized: "自定义笔设置读取失败：\(error.localizedDescription)")
        }
    }

    deinit {
        securityScopedRoot?.stopAccessingSecurityScopedResource()
    }

    @discardableResult
    func saveSavedPen(_ pen: SavedPen) -> Bool {
        if childRoot !== self { return childRoot.saveSavedPen(pen) }
        guard !isBusy else { return false }
        let value = normalizedSavedPen(pen)
        var pens = savedPens
        if let index = pens.firstIndex(where: { $0.id == value.id }) {
            pens[index] = value
        } else { pens.append(value) }
        guard persistSavedPens(pens, selectedID: value.id) else { return false }
        selectSavedPen(value.id)
        return true
    }

    func selectSavedPen(_ id: UUID) {
        if childRoot !== self { childRoot.selectSavedPen(id); return }
        guard !isBusy, savedPens.contains(where: { $0.id == id }) else { return }
        guard persistSavedPens(savedPens, selectedID: id) else { return }
        mode = .ink
        if usesPhoneInterface { phoneMarkupEnabled = false }
        savedPenSelectionRequest = SavedPenSelectionRequest(penID: id)
        synchronizeChildInputPolicy()
    }

    func deleteSavedPen(_ id: UUID) {
        if childRoot !== self { childRoot.deleteSavedPen(id); return }
        guard !isBusy else { return }
        let oldSelection = selectedSavedPenID
        let settings = SavedPenSettings(pens: savedPens, selectedID: oldSelection).removingPen(id)
        guard persistSavedPens(settings.pens, selectedID: settings.selectedID) else { return }
        if oldSelection == id {
            savedPenSelectionRequest = settings.selectedID.map { SavedPenSelectionRequest(penID: $0) }
        } else if savedPenSelectionRequest?.penID == id { savedPenSelectionRequest = nil }
        synchronizeChildInputPolicy()
    }

    func moveSavedPens(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        if childRoot !== self { childRoot.moveSavedPens(fromOffsets: offsets, toOffset: destination); return }
        guard !isBusy, (0...savedPens.count).contains(destination),
              offsets.allSatisfy({ savedPens.indices.contains($0) }) else { return }
        var pens = savedPens
        pens.move(fromOffsets: offsets, toOffset: destination)
        do {
            let palette = try NativePaletteSettings(entries: nativePaletteEntries).reorderingPens(penIDs: pens.map(\.id))
            _ = persistSavedPens(pens, selectedID: selectedSavedPenID, paletteEntries: palette.entries)
        } catch { recordPaletteSettingsError(error) }
    }

    func moveNativePaletteEntries(fromOffsets offsets: IndexSet, toOffset destination: Int) {
        if childRoot !== self { childRoot.moveNativePaletteEntries(fromOffsets: offsets, toOffset: destination); return }
        guard !isBusy else { return }
        do {
            let palette = try NativePaletteSettings(entries: nativePaletteEntries).moving(fromOffsets: offsets, toOffset: destination)
            let pensByID = Dictionary(uniqueKeysWithValues: savedPens.map { ($0.id, $0) })
            let orderedPens = palette.entries.compactMap(\.penID).compactMap { pensByID[$0] }
            guard orderedPens.count == savedPens.count else { throw NativePaletteSettingsError.invalidSettings }
            _ = persistSavedPens(orderedPens, selectedID: selectedSavedPenID, paletteEntries: palette.entries)
        } catch { recordPaletteSettingsError(error) }
    }

    func removeNativePaletteEntry(_ entry: NativePaletteEntry) {
        if childRoot !== self { childRoot.removeNativePaletteEntry(entry); return }
        guard !isBusy, nativePaletteEntries.contains(entry) else { return }
        if let penID = entry.penID { deleteSavedPen(penID); return }
        let palette = NativePaletteSettings(entries: nativePaletteEntries).removing(entry)
        _ = persistSavedPens(savedPens, selectedID: selectedSavedPenID, paletteEntries: palette.entries)
    }

    func restoreNativePaletteUtility(_ entry: NativePaletteEntry) {
        if childRoot !== self { childRoot.restoreNativePaletteUtility(entry); return }
        guard !isBusy, entry.isUtility, !nativePaletteEntries.contains(entry) else { return }
        let palette = NativePaletteSettings(entries: nativePaletteEntries).restoringUtility(entry)
        _ = persistSavedPens(savedPens, selectedID: selectedSavedPenID, paletteEntries: palette.entries)
    }

    func requestSavedPenEditor(_ penID: UUID) {
        if childRoot !== self { childRoot.requestSavedPenEditor(penID); return }
        guard !isBusy, !isPadReading, !reviewModeEnabled, savedPens.contains(where: { $0.id == penID }) else { return }
        nativePenEditorRequest = SavedPenSelectionRequest(penID: penID)
    }

    func requestNativePaletteEditor() {
        if childRoot !== self { childRoot.requestNativePaletteEditor(); return }
        guard !isBusy else { return }
        nativePaletteEditorRequestID = UUID()
    }

    /// Native tool changes update preferences without issuing another canvas command.
    func noteSelectedSavedPen(_ id: UUID?) {
        if childRoot !== self { childRoot.noteSelectedSavedPen(id); return }
        let selection = id.flatMap { value in savedPens.contains(where: { $0.id == value }) ? value : nil }
        guard selectedSavedPenID != selection else { return }
        _ = persistSavedPens(savedPens, selectedID: selection)
    }

    func updateSavedPenTool(id: UUID, red: Double, green: Double, blue: Double, alpha: Double, width: Double) {
        if childRoot !== self { childRoot.updateSavedPenTool(id: id, red: red, green: green, blue: blue, alpha: alpha, width: width); return }
        guard let index = savedPens.firstIndex(where: { $0.id == id }) else { return }
        var pens = savedPens
        var pen = pens[index]
        pen.red = red; pen.green = green; pen.blue = blue; pen.alpha = alpha; pen.width = width
        pen = normalizedSavedPen(pen)
        guard pen != pens[index] else { return }
        pens[index] = pen
        _ = persistSavedPens(pens, selectedID: selectedSavedPenID)
    }

    private func normalizedSavedPen(_ original: SavedPen) -> SavedPen {
        var pen = original
        let trimmed = pen.name.trimmingCharacters(in: .whitespacesAndNewlines)
        pen.name = trimmed.isEmpty ? pen.kind.title : String(trimmed.prefix(80))
        func component(_ value: Double, fallback: Double = 0) -> Double {
            value.isFinite ? min(1, max(0, value)) : fallback
        }
        pen.red = component(pen.red); pen.green = component(pen.green); pen.blue = component(pen.blue)
        pen.alpha = component(pen.alpha, fallback: 1)
        let width = pen.width.isFinite ? pen.width : pen.kind.defaultWidth
        pen.width = min(pen.kind.maximumWidth, max(pen.kind.minimumWidth, width))
        return pen
    }

    @discardableResult
    private func persistSavedPens(_ pens: [SavedPen], selectedID: UUID?, paletteEntries: [NativePaletteEntry]? = nil) -> Bool {
        do {
            let settings = SavedPenSettings(pens: pens, selectedID: selectedID)
            try settings.validate()
            let palette = try NativePaletteSettings(entries: paletteEntries ?? nativePaletteEntries).reconciled(penIDs: pens.map(\.id))
            // Validate and encode both blobs before publishing either setting.
            // The pen library is written first; relaunch reconciliation can repair
            // a process interruption between these two preferences writes.
            let penData = try JSONEncoder().encode(settings)
            let paletteData = try JSONEncoder().encode(palette)
            UserDefaults.standard.set(penData, forKey: SavedPenSettings.defaultsKey)
            UserDefaults.standard.set(paletteData, forKey: NativePaletteSettings.defaultsKey)
            if savedPens != pens { savedPens = pens }
            if selectedSavedPenID != selectedID { selectedSavedPenID = selectedID }
            if nativePaletteEntries != palette.entries { nativePaletteEntries = palette.entries }
            synchronizeChildInputPolicy()
            return true
        } catch {
            DiagnosticsCenter.shared.record(code: .settingsFailed, operation: .settings, error: error)
            status = String(localized: "自定义笔未能保存：\(error.localizedDescription)")
            return false
        }
    }

    private func recordPaletteSettingsError(_ error: Error) {
        DiagnosticsCenter.shared.record(code: .settingsFailed, operation: .settings, error: error)
        status = String(localized: "原生笔栏未能保存：\(error.localizedDescription)")
    }

    func restoreVault() async {
        let remembered = windowPersistence?.location
        let bookmark = remembered?.bookmark ?? (windowPersistence == nil ? UserDefaults.standard.data(forKey: "vaultBookmark") : nil)
        guard let bookmark else { return }
        let lastBoardPath = remembered?.boardPath ?? (windowPersistence == nil ? UserDefaults.standard.string(forKey: "lastBoardPath") : nil)
        do {
            var stale = false
            let url = try URL(resolvingBookmarkData: bookmark, options: [],
                              relativeTo: nil, bookmarkDataIsStale: &stale)
            try await attachVault(url)
            if boardURL == nil, let path = lastBoardPath {
                // A temporarily unavailable cloud leaf must remain the next
                // restoration target, even when this opening attempt fails.
                rememberBoard(path)
                _ = await openBoard(relativePath: path)
            }
        } catch {
            DiagnosticsCenter.shared.record(code: .vaultAccessFailed, operation: .connectVault, error: error)
            status = String(localized: "需要重新选择仓库：\(error.localizedDescription)")
        }
    }

    func attachVault(_ url: URL, catalogVaultID: UUID? = nil) async throws {
        guard !isBusy else { throw VaultWriteError.unavailable }
        isBusy = true
        defer { isBusy = false }
        guard await flushEdits() else { throw VaultWriteError.unavailable }
        let newAccess = url.startAccessingSecurityScopedResource()
        do {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else { throw VaultWriteError.unavailable }
            let bookmark = try url.bookmarkData(options: .minimalBookmark,
                                                includingResourceValuesForKeys: nil,
                                                relativeTo: nil)
            if securityAccess { vaultURL?.stopAccessingSecurityScopedResource() }
            securityAccess = newAccess
            securityScopedRoot = newAccess ? url : nil
            clearChildSessions()
            cancelPendingAutosave()
            vaultURL = url
            library = DocumentLibrary(rootURL: url)
            rememberVault(bookmark)
            selectedPrintFrameID = nil
            capturedPrintRegion = nil
            printTool = .select
            beginPhoneReading()
            reviewModeEnabled = false
        canvasSessionID = UUID()
            document = BoardDocument()
            insertionPoint = nil
            boardFilesWarning = nil
            library?.annotationOwnersToHide = document.pdfDisplayOwnerIDs
            obsidianNoteURL = nil
            needsLinkRetry = false
            drawing = PKDrawing()
            command = nil
            boardURL = nil
            diskFingerprint = nil
            isDirty = false
            thumbnails.removeAllObjects()
            requestedThumbnails.removeAll()
            failedThumbnails.removeAll()
            status = String(localized: "已连接 \(url.lastPathComponent) · 可以新建或打开白板")
            _ = await boardCatalog.attach(rootURL: url, preferredVaultID: catalogVaultID)
            await backups.activate(document: document, vaultURL: url)
            recordRecentBrowse(kind: .folder, title: url.lastPathComponent)
            if let pendingOpenPath {
                self.pendingOpenPath = nil
                isBusy = false
                await openBoard(relativePath: pendingOpenPath)
            }
        } catch {
            if newAccess { url.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    @discardableResult
    func newBoard(title: String, directoryPath: String = "InkSpace") async -> Bool {
        guard !usesPhoneInterface, !isBusy else { return false }
        isBusy = true
        defer { isBusy = false }
        guard let vaultURL else { status = String(localized: "请先选择仓库"); return false }
        guard await flushEdits() else { return false }
        do {
            let directory = try await BoardStorageLocations.prepareDirectory(root: vaultURL,
                relativePath: directoryPath, createDefault: true)
            try Task.checkCancellation()
            var fresh = BoardDocument()
            let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            fresh.title = cleanTitle.isEmpty ? String(localized: "新白板") : cleanTitle
            let emptyDrawing = PKDrawing()
            fresh.drawing = try await BoardSavePreparation.drawingData(emptyDrawing)
            fresh.webInk = BoardWebInk()
            fresh.writerID = writerID
            fresh.revision = 1
            let destination = directory.appendingPathComponent("\(safeFilename(fresh.title))-\(fresh.id.uuidString.prefix(8)).inkspace.json")
            let freshBytes = try await BoardSavePreparation.encode(fresh)
            let fingerprint = try await io.write(freshBytes, to: destination, expectedFingerprint: nil)
            // Switch only after a durable new file exists. Failures above preserve
            // the old document, drawing, URL, selection, viewport and bookmark.
            cancelPendingAutosave()
            selectedPrintFrameID = nil
            capturedPrintRegion = nil
            printTool = .select
            beginPhoneReading()
            padReadingEnabled = false
            reviewModeEnabled = false
        canvasSessionID = UUID()
            if !isEmbeddedSession { clearChildSessions() }
            document = fresh
            insertionPoint = nil
            library?.annotationOwnersToHide = fresh.pdfDisplayOwnerIDs
            obsidianNoteURL = nil
            needsLinkRetry = false
            drawing = emptyDrawing
            seedPreparedDrawingData(fresh.drawing)
            selectedIDs = []
            boardURL = destination
            diskFingerprint = fingerprint
            viewportCenter = CGPoint(x: fresh.viewport.x, y: fresh.viewport.y)
            zoom = fresh.viewport.zoom
            generation += 1
            isDirty = false
            lastSnapshot = nil
            thumbnails.removeAllObjects()
            requestedThumbnails.removeAll()
            failedThumbnails.removeAll()
            command = CanvasCommand(action: .restoreViewport(viewportCenter, zoom: zoom))
            if let path = relativePath(for: destination) {
                rememberBoard(path)
                await boardCatalog.recordOpened(rootURL: vaultURL, relativePath: path,
                                                title: fresh.title, boardID: fresh.id)
                do {
                    obsidianNoteURL = try await io.ensureObsidianNote(boardURL: destination,
                        relativePath: path, boardID: fresh.id)
                    status = String(localized: "白板已创建 · \(directoryPath.isEmpty ? String(localized: "仓库根目录") : directoryPath)")
                } catch {
                    DiagnosticsCenter.shared.record(code: .previewExportFailed, operation: .exportPreview, error: error)
                    needsLinkRetry = true
                    status = String(localized: "白板已创建，Obsidian 入口待重试：\(error.localizedDescription)")
                }
            }
            await backups.activate(document: document, vaultURL: vaultURL)
            // The initial empty board is already durable in the selected folder.
            // Retain its editable local checkpoint too, honoring the board's backup policy.
            _ = try? await BoardSavePreparation.withInkMemoryLease {
                await backups.captureEditableCheckpoint(document: fresh, vaultURL: vaultURL)
            }
            if needsLinkRetry { scheduleAutosaveRetry() }
            if let path = relativePath(for: destination) { recordRecentBrowse(kind: .board, relativePath: path, title: fresh.title) }
            return true
        } catch {
            DiagnosticsCenter.shared.record(code: .boardCreateFailed, operation: .createBoard, error: error)
            status = String(localized: "新建失败，当前白板保留：\(error.localizedDescription)")
            return false
        }
    }

    func boardFiles() async -> [URL] {
        guard let root = vaultURL else { return [] }
        let result = await BoardStorageLocations.discover(root: root)
        guard !Task.isCancelled, vaultURL == root else { return [] }
        boardFilesWarning = result.warning
        return result.files
    }

    @discardableResult
    func openBoard(relativePath: String) async -> Bool {
        guard !isBusy else { status = String(localized: "正在处理文件，请稍后再打开"); return false }
        guard VaultPath.isSafeRelative(relativePath), relativePath.hasSuffix(".inkspace.json") else {
            DiagnosticsCenter.shared.record(code: .boardOpenFailed, operation: .openBoard)
            status = String(localized: "白板路径无效"); return false
        }
        guard let library, let url = library.resolve(relativePath: relativePath) else {
            if vaultURL == nil { pendingOpenPath = relativePath }
            DiagnosticsCenter.shared.record(code: .boardOpenFailed, operation: .openBoard)
            status = String(localized: "白板暂不可用，请检查仓库授权或 iCloud 下载状态。"); return false
        }
        if let root = vaultURL { supersedeWindowNavigationForBoardOpen(path: relativePath, root: root) }
        if focusPeerIfAlreadyOpen(url) { return false }
        if boardURL == url, !isDirty, !isSaving {
            let opened = await refreshExternalChanges(force: true)
            if opened { recordRecentBrowse(kind: .board, relativePath: relativePath, title: document.title) }
            return opened
        }
        isBusy = true
        defer { isBusy = false }
        guard await flushEdits() else { return false }
        do {
            let loaded = try await readLoader.load(url)
            try Task.checkCancellation()
            let board = loaded.document
            if focusPeerIfAlreadyOpen(url) { return false }
            activateOpenedBoard(board, ink: loaded.drawing, fingerprint: loaded.fingerprint, url: url, relativePath: relativePath)
            if let vaultURL {
                await boardCatalog.recordOpened(rootURL: vaultURL, relativePath: relativePath,
                                                title: board.title, boardID: board.id)
                await backups.activate(document: document, vaultURL: vaultURL)
            }
            recordRecentBrowse(kind: .board, relativePath: relativePath, title: board.title)
            return true
        } catch {
            DiagnosticsCenter.shared.record(code: .boardOpenFailed, operation: .openBoard, error: error)
            status = String(localized: "打开失败，当前内容保留：\(error.localizedDescription)")
            return false
        }
    }

    /// One save/read/commit transaction. The target is never reopened after the
    /// old workspace is replaced, and no vault switch can interleave at an await.
    func openCatalogEntry(_ entry: BoardCatalogEntry, reconnectingTo chosenRoot: URL? = nil) async -> Bool {
        guard !isBusy else { return false }
        isBusy = true
        defer { isBusy = false }
        do {
            let root = try chosenRoot ?? boardCatalog.authorizedURL(for: entry.vaultID)
            let access = root.startAccessingSecurityScopedResource()
            var transferredAccess = false
            defer { if access && !transferredAccess { root.stopAccessingSecurityScopedResource() } }
            let canonical = try BoardStorageLocations.directory(root: root, relativePath: "")
            if let knownVault = boardCatalog.vaults.first(where: { $0.canonicalPath == canonical.path }),
               knownVault.id != entry.vaultID { throw BoardHistoryOpenError.wrongVault }
            guard entry.relativePath.hasSuffix(".inkspace.json"),
                  let target = VaultPathResolver.resolve(relativePath: entry.relativePath, within: root) else {
                throw VaultWriteError.unavailable
            }
            supersedeWindowNavigationForBoardOpen(path: entry.relativePath, root: root)
            if focusPeerIfAlreadyOpen(target) { return false }
            // Save the current board before reading a target that might be that
            // same file. Failure preserves the old model, URL and authorization.
            guard await flushEdits() else { return false }
            let loaded = try await readLoader.load(target)
            let candidate = loaded.document
            if focusPeerIfAlreadyOpen(target) { return false }
            if let expectedID = entry.boardID, candidate.id != expectedID {
                throw BoardHistoryOpenError.wrongBoard
            }
            let ink = loaded.drawing
            let bookmark = try root.bookmarkData(options: .minimalBookmark,
                includingResourceValuesForKeys: nil, relativeTo: nil)
            try Task.checkCancellation()
            // Everything fallible is prepared. These assignments have no await:
            // the folder and its already decoded board become visible together.
            if securityAccess { vaultURL?.stopAccessingSecurityScopedResource() }
            securityAccess = access
            securityScopedRoot = access ? root : nil
            transferredAccess = true
            vaultURL = root
            library = DocumentLibrary(rootURL: root)
            rememberVault(bookmark)
            pendingOpenPath = nil
            activateOpenedBoard(candidate, ink: ink, fingerprint: loaded.fingerprint,
                                url: target, relativePath: entry.relativePath)
            _ = await boardCatalog.attach(rootURL: root, preferredVaultID: entry.vaultID)
            await boardCatalog.recordOpened(rootURL: root, relativePath: entry.relativePath,
                                            title: candidate.title, boardID: candidate.id)
            await backups.activate(document: document, vaultURL: root)
            recordRecentBrowse(kind: .board, relativePath: entry.relativePath, title: candidate.title)
            return true
        } catch {
            DiagnosticsCenter.shared.record(code: .boardOpenFailed, operation: .openBoard, error: error)
            status = String(localized: "打开失败，当前内容保留：\(error.localizedDescription)")
            return false
        }
    }

    /// Passive updates of this exact board retain the user's iPad input choice.
    /// Explicit opens and the phone keep their existing read-only entry policy.
    private static func preservesInputPolicyForRefresh(refreshingCurrentBoard: Bool, usesPhoneInterface: Bool,
                                                       currentBoardID: UUID, incomingBoardID: UUID,
                                                       currentURL: URL?, incomingURL: URL) -> Bool {
        refreshingCurrentBoard && !usesPhoneInterface && currentBoardID == incomingBoardID
            && currentURL?.standardizedFileURL == incomingURL.standardizedFileURL
    }

    func activateOpenedBoard(_ board: BoardDocument, ink: PKDrawing, fingerprint: String,
                                     url: URL, relativePath: String, refreshingCurrentBoard: Bool = false) {
        let preservesInput = Self.preservesInputPolicyForRefresh(refreshingCurrentBoard: refreshingCurrentBoard,
            usesPhoneInterface: usesPhoneInterface, currentBoardID: document.id, incomingBoardID: board.id,
            currentURL: boardURL, incomingURL: url)
        let priorSelection = selectedIDs
        let priorPrintFrame = selectedPrintFrameID
        fileManagementInProgress = false
        cancelPendingAutosave()
        externalRefreshStatus = ""
        if !preservesInput {
            selectedPrintFrameID = nil
            capturedPrintRegion = nil
            printTool = .select
            beginPhoneReading()
            padReadingEnabled = !usesPhoneInterface
        }
        reviewModeEnabled = false
        canvasSessionID = UUID()
        if !isEmbeddedSession { clearChildSessions() }
        document = board
        document.canvasWidth = 8_000_000
        document.canvasHeight = 8_000_000
        insertionPoint = nil
        library?.annotationOwnersToHide = board.pdfDisplayOwnerIDs
        obsidianNoteURL = nil
        needsLinkRetry = board.pdfAnnotationSources?.contains { $0.sha256 == String(repeating: "0", count: 64) } == true
        drawing = ink
        seedPreparedDrawingData(board.drawing)
        diskFingerprint = fingerprint
        boardURL = url
        selectedIDs = preservesInput ? priorSelection.intersection(Set(board.items.map(\.id))) : []
        if preservesInput {
            selectedPrintFrameID = priorPrintFrame.flatMap { id in
                board.printFrames?.contains(where: { $0.id == id }) == true ? id : nil
            }
        }
        isDirty = false
        generation += 1
        viewportCenter = CGPoint(x: board.viewport.x, y: board.viewport.y)
        zoom = board.viewport.zoom
        command = CanvasCommand(action: .restoreViewport(viewportCenter, zoom: zoom))
        thumbnails.removeAllObjects()
        requestedThumbnails.removeAll()
        failedThumbnails.removeAll()
        rememberBoard(relativePath)
        status = String(localized: "已打开 · \(board.items.count) 个对象 · iCloud 传输状态由系统管理")
    }

    /// Flush existing ink before a filesystem transaction. No previous canvas can
    /// save to an obsolete path while the actor moves files or refreshes references.
    func manageFiles(_ action: VaultFileManagementAction, service: VaultFileManagement) async throws -> URL? {
        if usesPhoneInterface {
            guard case .share = action else { throw VaultFileManagementError.changed }
        }
        guard !isBusy, !externalInteractionActive, !reviewModeEnabled, reviews.draft == nil,
              let root = vaultURL,
              root.standardizedFileURL.resolvingSymlinksInPath() == service.rootURL else { throw VaultFileManagementError.changed }
        isBusy = true
        var recoveryRequired = false
        defer { isBusy = false; if !recoveryRequired { fileManagementInProgress = false } }
        guard await flushEdits() else { throw VaultFileManagementError.changed }
        let session = canvasSessionID, originalPath = boardURL.flatMap { relativePath(for: $0) }
        clearChildSessions()
        cancelPendingAutosave()
        fileManagementInProgress = true
        do {
            let result: VaultManagementResult
            switch action {
            case .move(let paths, let destination): result = try await service.move(paths: paths, to: destination)
            case .trash(let paths): result = try await service.trash(paths: paths)
            case .restore(let id): result = try await service.restore(id: id)
            case .share(let paths): return try await service.prepareShare(paths: paths)
            }
            guard canvasSessionID == session, vaultURL == root else { throw VaultFileManagementError.recoveryRequired }
            if let path = originalPath, result.removes(path) {
                // The user explicitly trashed this saved board. Detach its old URL;
                // later editing must not recreate the trashed file through autosave.
                document = BoardDocument(); drawing = PKDrawing(); canvasSessionID = UUID()
                boardURL = nil; diskFingerprint = nil; isDirty = false; needsLinkRetry = false
                obsidianNoteURL = nil; selectedIDs = []; insertionPoint = nil
                viewportCenter = CGPoint(x: 500_000, y: 500_000); zoom = 1
                command = CanvasCommand(action: .restoreViewport(viewportCenter, zoom: zoom))
                rememberBoard(nil)
            } else if let path = originalPath {
                let target = result.mapped(path)
                if target != path || result.changedBoards.contains(target) {
                    guard let url = library?.resolve(relativePath: target) else { throw VaultFileManagementError.recoveryRequired }
                    do {
                        let loaded = try await readLoader.load(url)
                        guard canvasSessionID == session, vaultURL == root else { throw VaultFileManagementError.recoveryRequired }
                        activateOpenedBoard(loaded.document, ink: loaded.drawing, fingerprint: loaded.fingerprint, url: url, relativePath: target)
                    } catch { throw VaultFileManagementError.recoveryRequired }
                }
            }
            library?.clearCache(); previewEpoch += 1
            await boardCatalog.relocate(rootURL: root, moves: result.moves.map { (from: $0.from, to: $0.to) })
            await boardCatalog.refreshCurrentVault()
            await attachReviews()
            status = String(localized: "文件操作完成；当前白板已按新位置重新连接。")
            return nil
        } catch {
            if case VaultFileManagementError.recoveryRequired = error {
                recoveryRequired = true
                status = String(localized: "文件操作尚待恢复，当前笔迹保留；自动保存已暂停，避免写入旧位置。请打开已确认位置的白板后继续。")
            }
            throw error
        }
    }

    /// A manual refresh reads the same coordinated files as automatic refresh.
    /// It never writes a board or treats an iCloud request as a completed sync.
    @discardableResult
    func refreshBoardManually() async -> Bool {
        guard !isRefreshingBoard else { return false }
        guard boardURL != nil, vaultURL != nil else {
            externalRefreshStatus = String(localized: "请先保存白板，再刷新。")
            return false
        }
        guard !refreshInProgress, !isBusy, !isSaving, !isDirty, !childSessionsHavePendingEdits,
              !externalRefreshPaused, !externalInteractionActive, mode == .ink,
              !reviewModeEnabled, reviews.draft == nil, !reviews.isWriting,
              readingCanvas?.snapshotInteractionActive != true else {
            externalRefreshStatus = String(localized: "当前修改已保留，请先保存并结束操作，切换阅读后再刷新。")
            return false
        }
        let url = boardURL
        isRefreshingBoard = true
        defer { isRefreshingBoard = false }
        externalRefreshStatus = String(localized: "正在重新读取白板和资料…")
        let refreshed = await refreshExternalChanges(force: true)
        guard boardURL == url else { return false }
        if refreshed {
            refreshPreviews()
            externalRefreshStatus = String(localized: "已刷新本机可用文件；iCloud 尚未传到的更改仍需等待。")
        }
        return refreshed
    }

    /// A failed or late read never edits disk. Background refresh excludes linked
    /// asset inspection and uses a smaller current-board byte budget.
    @discardableResult
    func refreshExternalChanges(force: Bool = false, editing: Bool = false,
                                includeLinkedAssets: Bool = true,
                                maximumReadBytes: Int = BoardReadLoader.maximumBytes) async -> Bool {
        // Automatic metadata/hash polling yields before starting file work while
        // any live canvas is writing or moving. Forced refresh keeps its existing
        // dirty/session checks and never gains permission to replace active ink.
        guard force || !automaticRefreshInteractionActive else { return false }
        guard !isReadAloudActive else {
            externalRefreshStatus = String(localized: "朗读使用当前资料快照，停止后继续检查更新。")
            return false
        }
        guard !refreshInProgress, !isBusy, !isSaving, let url = boardURL,
              let root = vaultURL, let fingerprint = diskFingerprint,
              let path = relativePath(for: url),
              VaultPathResolver.resolve(relativePath: path, within: root) == url else { return false }
        refreshInProgress = true
        defer { refreshInProgress = false }
        let identity = BoardRefreshIdentity(session: canvasSessionID, boardID: document.id,
            generation: generation, fingerprint: fingerprint, url: url)
        let protected = editing || childSessionsHavePendingEdits || externalRefreshPaused || externalInteractionActive || readingCanvas?.snapshotInteractionActive == true || mode != .ink || reviewModeEnabled || reviews.draft != nil || reviews.isWriting
        do {
            let change = try await readLoader.changed(url, expectedFingerprint: fingerprint,
                allowReload: !isDirty && !protected, force: force, maximumBytes: maximumReadBytes)
            try Task.checkCancellation()
            guard canvasSessionID == identity.session, boardURL == url, vaultURL == root else { return false }
            // Input may begin while the actor's read is suspended. Keep automatic
            // reload and linked-preview work pending for the next quiet check.
            guard force || !automaticRefreshInteractionActive else { return false }
            switch change {
            case .unchanged: break
            case .deferred:
                externalRefreshStatus = String(localized: "其他设备有更新；本机未保存内容保留，保存时将检查冲突。")
                return false
            case .loaded(let loaded):
                // Speech may start while the file read is suspended. Its
                // immutable source must survive returning from another app.
                guard !isReadAloudActive else {
                    externalRefreshStatus = String(localized: "朗读使用当前资料快照，停止后继续检查更新。")
                    return false
                }
                let current = diskFingerprint.map { BoardRefreshIdentity(session: canvasSessionID,
                    boardID: document.id, generation: generation, fingerprint: $0, url: url) }
                guard identity.mayApply(current: current, dirty: isDirty, saving: isSaving,
                                       busy: isBusy, editing: protected || childSessionsHavePendingEdits || externalRefreshPaused || externalInteractionActive || readingCanvas?.snapshotInteractionActive == true || mode != .ink || reviewModeEnabled || reviews.draft != nil || reviews.isWriting),
                      loaded.document.id == document.id else {
                    externalRefreshStatus = String(localized: "外部白板有变化；当前内容保留，请稍后重新打开。")
                    return false
                }
                let center = viewportCenter, readingZoom = zoom
                activateOpenedBoard(loaded.document, ink: loaded.drawing, fingerprint: loaded.fingerprint,
                                    url: url, relativePath: path, refreshingCurrentBoard: true)
                viewportCenter = center; zoom = readingZoom
                command = CanvasCommand(action: .restoreViewport(center, zoom: readingZoom))
                library?.clearCache()
                externalRefreshStatus = String(localized: "已载入其他设备的更新，阅读位置已保留。")
            }
            guard includeLinkedAssets else { return true }
            return try await refreshLinkedPreviewsIfNeeded(root: root, url: url, force: force)
        } catch is CancellationError { return false }
        catch {
            guard canvasSessionID == identity.session, boardURL == url else { return false }
            externalRefreshStatus = String(localized: "外部更新暂未读完，当前白板保留；稍后会自动重试。")
            return false
        }
    }

    /// Asset metadata can finish while a new stroke or viewport gesture begins.
    /// Keep its invalidation pending rather than clearing visible previews mid-input.
    /// The loader already remembers each stamp, so the pending event must survive
    /// until a quiet poll; otherwise its next result would report no change.
    private func refreshLinkedPreviewsIfNeeded(root: URL, url: URL, force: Bool) async throws -> Bool {
        let identity = LinkedPreviewIdentity(session: canvasSessionID, boardID: document.id,
            boardURL: url, vaultURL: root)
        if deferredLinkedPreviewRefresh != identity { deferredLinkedPreviewRefresh = nil }
        guard boardURL == url, vaultURL == root, force || !automaticRefreshInteractionActive else { return false }
        try Task.checkCancellation()
        if deferredLinkedPreviewRefresh == nil {
            let paths = Set(document.items.flatMap { [$0.sourcePath, $0.originalSourcePath].compactMap { $0 } })
            let assetsChanged = try await readLoader.linkedAssetsChanged(root: root, paths: paths)
            guard canvasSessionID == identity.session, document.id == identity.boardID,
                  boardURL == url, vaultURL == root else { return false }
            if assetsChanged { deferredLinkedPreviewRefresh = identity }
            // Preserve a consumed stamp even if this polling caller was cancelled.
            // Cancellation still forbids applying it; the next quiet poll owns it.
            try Task.checkCancellation()
        }
        guard !isSaving, !isBusy, force || !automaticRefreshInteractionActive else { return false }
        if deferredLinkedPreviewRefresh == identity { refreshPreviews() }
        return true
    }

    /// Call only with the already paired decoded drawing/document, or the
    /// freshly-created empty drawing whose archive has just been written.
    private func seedPreparedDrawingData(_ bytes: Data?) {
        guard let bytes else { preparedNativeDrawing = nil; return }
        preparedNativeDrawing = (nativeDrawingRevision, canvasSessionID, document.id, bytes)
    }

    private func preparedDrawingData(_ ink: PKDrawing, revision: UInt64, session: UUID, boardID: UUID,
                                     probe: BoardLassoMemoryProbe.Context? = nil) async throws -> Data {
        if let cached = preparedNativeDrawing, cached.revision == revision,
           cached.session == session, cached.boardID == boardID {
            BoardLassoMemoryProbe.mark(probe, .archiveCacheHit, .point, value: UInt64(cached.bytes.count))
            try Task.checkCancellation()
            return cached.bytes
        }
        let token: UUID
        let task: Task<Data, Error>
        if let pending = nativeDrawingPreparation, pending.revision == revision,
           pending.session == session, pending.boardID == boardID {
            token = pending.id; task = pending.task
            BoardLassoMemoryProbe.mark(probe, .archivePending, .point)
        } else {
            token = UUID()
            BoardLassoMemoryProbe.mark(probe, .archiveTask, .point)
            task = Task.detached(priority: .utility) { try await BoardSavePreparation.drawingData(ink, probe: probe) }
            nativeDrawingPreparation = (token, revision, session, boardID, task)
        }
        defer { if nativeDrawingPreparation?.id == token { nativeDrawingPreparation = nil } }
        BoardLassoMemoryProbe.mark(probe, .archiveAwait, .begin)
        let bytes = try await withTaskCancellationHandler(operation: {
            try await task.value
        }, onCancel: {
            // A cancelled background budget must retire a queued archive too.
            // Other coalesced callers fail safely and can retry the live value.
            task.cancel()
        })
        BoardLassoMemoryProbe.mark(probe, .archiveAwait, .end, value: UInt64(bytes.count))
        if nativeDrawingRevision == revision, canvasSessionID == session, document.id == boardID {
            preparedNativeDrawing = (revision, session, boardID, bytes)
        }
        try Task.checkCancellation()
        return bytes
    }

    private func preparedOutputSnapshot() async throws -> BoardDocument {
        var snapshot = document
        let ink = drawing, revision = nativeDrawingRevision, session = canvasSessionID
        snapshot.viewport = BoardViewport(x: viewportCenter.x, y: viewportCenter.y, zoom: zoom)
        snapshot.drawing = try await preparedDrawingData(ink, revision: revision, session: session, boardID: snapshot.id)
        return snapshot
    }

    /// Auxiliary backups never turn a successful open/native save into failure.
    /// Failed preparation has no bytes to publish, and never uses stale drawing.
    @discardableResult private func capturePreparedBackup(vaultURL: URL, reason: BoardBackupReason) async -> Bool {
        do {
            let snapshot = try await preparedOutputSnapshot()
            try await BoardSavePreparation.withInkMemoryLease {
                await backups.capture(document: snapshot, vaultURL: vaultURL, reason: reason)
            }
            return true
        } catch {
            if !(error is CancellationError) {
                DiagnosticsCenter.shared.record(code: .backupFailed, operation: .localBackup, error: error)
                status = String(localized: "本次辅助备份暂缓，已有版本保留：\(error.localizedDescription)")
            }
            return false
        }
    }

    func flushEdits() async -> Bool {
        guard await flushChildSessions() else { return false }
        guard await reviews.flush() else { return false }
        while isSaving || isDirty {
            guard await save() else { return false }
        }
        if boardURL != nil, let vaultURL {
            _ = await capturePreparedBackup(vaultURL: vaultURL, reason: .session)
        }
        // New ink can arrive while an auxiliary backup awaits. Never let a
        // navigation caller replace an unsaved generation after that suspension.
        return !isDirty && !isSaving
    }

    func endSessionAndBackup() async {
        if reviewModeEnabled { _ = await reviews.flush(); return }
        guard !isBusy, let vaultURL else { return }
        isBusy = true
        defer { isBusy = false }
        let saved = await save()
        guard saved, !isDirty else { await DiagnosticsCenter.shared.refresh(); return }
        let captured = await capturePreparedBackup(vaultURL: vaultURL, reason: .manual)
        await DiagnosticsCenter.shared.refresh()
        if captured { status = backups.lastStatus }
    }

    func saveForBackground() {
        guard backgroundSaveTask == nil else { return }
        let token = UUID()
        let session = canvasSessionID
        let temporaryReview = reviewModeEnabled
        backgroundSaveToken = token
        backgroundSaveID = UIApplication.shared.beginBackgroundTask(withName: String(localized: "保存白板与本机备份")) { [weak self] in
            guard self?.backgroundSaveToken == token else { return }
            self?.backgroundSaveTask?.cancel()
            self?.finishBackgroundSave(token: token)
        }
        // Closing a scene can release its SwiftUI owner before this task starts.
        // The existing token/defer breaks the bounded task's self retention.
        backgroundSaveTask = Task { [self] in
            defer { self.finishBackgroundSave(token: token) }
            // An earlier in-flight save may have captured only the first strokes.
            // Drain newer dirty generations within the system's background time budget.
            var saved = false
            repeat {
                guard !Task.isCancelled, self.canvasSessionID == session else { return }
                guard await self.save() else { break }
                saved = true
            } while self.isDirty && !temporaryReview
            await DiagnosticsCenter.shared.refresh()
            guard saved, !self.isDirty, !temporaryReview, !Task.isCancelled, self.canvasSessionID == session,
                  let root = self.vaultURL, self.boardURL != nil else { return }
            _ = await self.capturePreparedBackup(vaultURL: root, reason: .session)
            await DiagnosticsCenter.shared.refresh()
        }
    }

    private func finishBackgroundSave(token: UUID) {
        guard backgroundSaveToken == token else { return }
        if backgroundSaveID != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundSaveID)
            backgroundSaveID = .invalid
        }
        backgroundSaveTask = nil
        backgroundSaveToken = nil
    }

    func changed() {
        markDirty(updateDocumentTimestamp: true)
    }

    /// Ink already has its own observable drawing channel. Updating a field of
    /// the large document on every Pencil callback also invalidates item views.
    func changedInk() {
        markDirty(updateDocumentTimestamp: false)
    }

    /// Camera changes already publish their viewport values. Keep persistence
    /// dirty without invalidating all item views through document metadata.
    func changedViewport() {
        markDirty(updateDocumentTimestamp: false)
    }

    private func markDirty(updateDocumentTimestamp: Bool) {
        guard !usesPhoneInterface, !reviewModeEnabled else { return }
        generation += 1
        if !isDirty { isDirty = true }
        if updateDocumentTimestamp { document.updatedAt = Date() }
        let pendingStatus = String(localized: "有更改 · 等待保存")
        if status != pendingStatus { status = pendingStatus }
        autosaveFailureCount = 0
        if autosaveFirstChange == nil { autosaveFirstChange = ContinuousClock.now }
        scheduleAutosave()
    }

    @discardableResult
    func commitExistingTextEdit(_ updated: BoardItem, expected: BoardItem,
                                boardID: UUID, sessionID: UUID) -> Bool {
        guard let host = readingCanvas else {
            status = String(localized: "白板编辑尚未准备好，输入内容仍保留，请稍后再点保存。")
            return false
        }
        return host.commitExistingTextEdit(updated, expected: expected,
                                           boardID: boardID, sessionID: sessionID)
    }

    private var hasPendingAutosave: Bool {
        !usesPhoneInterface && !reviewModeEnabled && !fileManagementInProgress
            && vaultURL != nil && (isDirty || (needsLinkRetry && !isPadReading))
    }

    private var autosaveInteractionActive: Bool {
        externalInteractionActive || readingCanvas?.snapshotInteractionActive == true
    }

    private func cancelPendingAutosave() {
        autosaveTask?.cancel(); autosaveTask = nil
        autosaveFirstChange = nil
        autosaveFailureCount = 0
    }

    private func scheduleAutosave(after retryDelay: Duration? = nil) {
        guard hasPendingAutosave else { return }
        // This independent timer must survive a cancelled sheet/background caller;
        // its own cancellation and session identity still prevent stale writes.
        autosaveTask?.cancel()
        let session = canvasSessionID
        let now = ContinuousClock.now
        // A quiet pause saves after 1.5 seconds; continuous writing cannot keep
        // postponing all persistence. The maximum dirty interval is 10 seconds.
        var deadline = retryDelay.map { now.advanced(by: $0) }
            ?? min(now.advanced(by: .milliseconds(1500)),
                   (autosaveFirstChange ?? now).advanced(by: .seconds(10)))
        // Once the maximum dirty interval expires, frequent in-stroke callbacks
        // must not keep creating immediately-fired timers while input is active.
        if deadline <= now, autosaveInteractionActive {
            deadline = now.advanced(by: .milliseconds(250))
        }
        autosaveTask = Task { [weak self] in
            do { try await ContinuousClock().sleep(until: deadline) } catch { return }
            guard !Task.isCancelled, let self, self.canvasSessionID == session else { return }
            // Cancellation owns only this delay, never an in-flight save.
            self.autosaveTask = nil
            // Only the automatic timer yields to live interaction. Explicit and
            // background saves still drain the latest state when requested.
            if self.autosaveInteractionActive {
                self.scheduleAutosave(after: .milliseconds(250))
                return
            }
            // The in-flight save's defer requeues changes made after its snapshot,
            // including its failure paths. Never abandon those dirty generations.
            guard !self.isSaving else { return }
            _ = await self.save()
            if self.canvasSessionID == session, self.hasPendingAutosave, self.autosaveTask == nil {
                self.scheduleAutosaveRetry()
            }
        }
    }

    private func scheduleAutosaveRetry() {
        guard hasPendingAutosave else { return }
        autosaveFailureCount = min(autosaveFailureCount + 1, 6)
        let seconds = min(60, 3 * (1 << (autosaveFailureCount - 1)))
        scheduleAutosave(after: .seconds(seconds))
    }

    /// Returning to the foreground or unlocking is an immediate retry opportunity
    /// for drafts whose provider was unavailable. Existing conflict checks still apply.
    func retryPendingAutosave() {
        for child in childSessions.values { child.retryPendingAutosave() }
        guard hasPendingAutosave, !isSaving else { return }
        autosaveFailureCount = 0
        scheduleAutosave(after: .zero)
    }

    @discardableResult
    func save(forceExports: Bool = false, preservingSourcePDFs: Bool = false) async -> Bool {
        let memoryProbe = BoardLassoMemoryProbe.context(session: canvasSessionID, boardID: document.id)
        BoardLassoMemoryProbe.mark(memoryProbe, .saveRequest, .begin,
            value: (forceExports ? 1 : 0) | (preservingSourcePDFs ? 2 : 0))
        defer { BoardLassoMemoryProbe.mark(memoryProbe, .saveRequest, .end) }
        // Explicit visual excerpts save their node without triggering unrelated
        // source-PDF writes. Preserve pre-existing retry state for the next normal save.
        if preservingSourcePDFs && childSessionsHavePendingEdits {
            status = String(localized:"请先保存子白板中的修改，再添加图片摘录。"); return false
        }
        let priorLinkRetry = needsLinkRetry
        if preservingSourcePDFs { autosaveTask?.cancel(); autosaveTask = nil }
        // Reading must not retry an iPad's pending PDF writeback or publish the
        // phone's viewport over the author's board. Sidecar saves stay enabled.
        if usesPhoneInterface { return await reviews.flush() }
        guard !fileManagementInProgress else { return false }
        guard await flushChildSessions(preservingSourcePDFs: preservingSourcePDFs) else { return false }
        if reviewModeEnabled { return await reviews.flush() }
        BoardLassoMemoryProbe.mark(memoryProbe, .saveWait, .begin, value: isSaving ? 1 : 0)
        while isSaving {
            do { try await Task.sleep(for: .milliseconds(30)) } catch { return false }
        }
        BoardLassoMemoryProbe.mark(memoryProbe, .saveWait, .end)
        guard isDirty || forceExports || needsLinkRetry else { return true }
        guard let vaultURL else { status = String(localized: "未保存：请先选择仓库"); return false }
        isSaving = true
        BoardLassoMemoryProbe.mark(memoryProbe, .save, .begin)
        autosaveTask?.cancel(); autosaveTask = nil
        autosaveFirstChange = nil
        defer {
            isSaving = false
            BoardLassoMemoryProbe.mark(memoryProbe, .save, .end)
            embeddingRoot?.reconcileChildSession(self)
            // A source-preserving excerpt must not immediately launch unrelated
            // PDF writeback just because an older link retry is still pending.
            if hasPendingAutosave && (!preservingSourcePDFs || isDirty) {
                if autosaveFirstChange != nil { scheduleAutosave() }
                else { scheduleAutosaveRetry() }
            } else { autosaveFailureCount = 0 }
        }
        let savedGeneration = generation
        var snapshot = document
        let inkSnapshot = drawing, inkRevision = nativeDrawingRevision, savedSession = canvasSessionID
        snapshot.viewport = BoardViewport(x: viewportCenter.x, y: viewportCenter.y, zoom: zoom)
        snapshot.updatedAt = Date()
        snapshot.writerID = writerID
        snapshot.revision += 1
        var savedNative = false
        BoardLassoMemoryProbe.mark(memoryProbe, .saveSnapshot, .point)
        do {
            snapshot.drawing = try await preparedDrawingData(inkSnapshot, revision: inkRevision,
                session: savedSession, boardID: snapshot.id, probe: memoryProbe)
            // The optional recovery checkpoint shares the high-memory lease,
            // but never invokes drawingData/encode while holding it.
            BoardLassoMemoryProbe.mark(memoryProbe, .checkpointLease, .begin)
            let backupGeneration = try await BoardSavePreparation.withInkMemoryLease {
                BoardLassoMemoryProbe.mark(memoryProbe, .checkpointLease, .end)
                BoardLassoMemoryProbe.mark(memoryProbe, .checkpoint, .begin)
                defer { BoardLassoMemoryProbe.mark(memoryProbe, .checkpoint, .end) }
                return await backups.captureEditableCheckpoint(document: snapshot, vaultURL: vaultURL)
            }
            status = String(localized: "正在保存白板与 Obsidian 预览…")
            let exported: BoardInkExport?
            var exportWarning: String?
            let pageGroups = Dictionary(grouping: snapshot.items.filter { $0.kind == .pdfPage && $0.sourcePath != nil }, by: { $0.sourcePath! })
            // Ordinary boards need the browser preview, but no second native
            // drawing or PDF synchronization. Keep the cleanup path when the
            // last PDF page was removed and old source ownership still exists.
            let shouldSynchronizePDF = !preservingSourcePDFs && snapshot.pdfWritebackSuspended != true
                && (!pageGroups.isEmpty || !(snapshot.pdfOwnedSourcePaths ?? []).isEmpty)
            BoardLassoMemoryProbe.mark(memoryProbe, .exportLease, .begin)
            do { exported = try await BoardSavePreparation.withInkMemoryLease {
                BoardLassoMemoryProbe.mark(memoryProbe, .exportLease, .end)
                BoardLassoMemoryProbe.mark(memoryProbe, .export, .begin)
                defer { BoardLassoMemoryProbe.mark(memoryProbe, .export, .end) }
                // These bytes and the native snapshot were captured from the
                // same inkRevision above, even if live ink changed while saving.
                return try await BoardWebExporter.export(drawingData: snapshot.drawing!, nativeDrawingSnapshot: inkSnapshot, items: snapshot.items,
                    canvasSize: snapshot.canvasWidth, needWorldDrawingData: shouldSynchronizePDF)
            } }
            catch {
                DiagnosticsCenter.shared.record(code: .previewExportFailed, operation: .exportPreview, error: error)
                exported = nil
                exportWarning = shouldSynchronizePDF
                    ? String(localized: "白板已完整保存；有手写节点无法预览，PDF 回写暂停：\(error.localizedDescription)")
                    : String(localized: "白板已完整保存；预览暂缓：\(error.localizedDescription)")
            }
            snapshot.webInk = exported?.webInk
            snapshot.lastInkLocation = exported?.lastInkLocation
            let boardOnlyPDFPages = exported?.boardOnlyPDFPages ?? [:]
            // Until the matching source bytes arrive, the companion retains web ink
            // and displays a synchronization placeholder rather than stale PDF ink.
            if !preservingSourcePDFs { snapshot.pdfAnnotationSources = pageGroups.keys.sorted().map {
                PDFAnnotationSource(sourcePath: $0, sha256: String(repeating: "0", count: 64),
                    pages: BoardPDFInkCoverage.sourcePages(Array(Set(pageGroups[$0]!.compactMap(\.page))).sorted(),
                        excluding: boardOnlyPDFPages[$0]))
            } } else if !boardOnlyPDFPages.isEmpty {
                // An excerpt save leaves source bytes unchanged. It must still
                // stop claiming an existing PDF page contains a new board fill.
                // Retain even an empty declaration so companions hide this
                // board's PDF annotations before drawing all ink in native order.
                snapshot.pdfAnnotationSources = snapshot.pdfAnnotationSources?.map { source in
                    var value = source
                    value.pages = BoardPDFInkCoverage.sourcePages(value.pages,
                        excluding: boardOnlyPDFPages[value.sourcePath])
                    return value
                }
            }
            let directoryPath: String
            if let boardURL {
                guard let path = relativePath(for: boardURL) else { throw BoardStorageError.invalidDirectory }
                directoryPath = (path as NSString).deletingLastPathComponent
            } else { directoryPath = "InkSpace" }
            let directory = try await BoardStorageLocations.prepareDirectory(root: vaultURL,
                relativePath: directoryPath, createDefault: boardURL == nil)
            var destination = boardURL ?? directory.appendingPathComponent("\(safeFilename(snapshot.title))-\(snapshot.id.uuidString.prefix(8)).inkspace.json")
            var fingerprint: String
#if INKSPACE_AUTOSAVE_TESTING
            await beforeNativeSave?()
#endif
            do {
                BoardLassoMemoryProbe.mark(memoryProbe, .encodeAwait, .begin)
                let nativeBytes = try await BoardSavePreparation.encode(snapshot, probe: memoryProbe)
                BoardLassoMemoryProbe.mark(memoryProbe, .encodeAwait, .end, value: UInt64(nativeBytes.count))
                BoardLassoMemoryProbe.mark(memoryProbe, .nativeWrite, .begin)
                fingerprint = try await io.write(nativeBytes, to: destination, expectedFingerprint: diskFingerprint)
                BoardLassoMemoryProbe.mark(memoryProbe, .nativeWrite, .end)
            } catch VaultWriteError.externalChange {
                DiagnosticsCenter.shared.record(code: .boardConflict, operation: .saveBoard, severity: .warning)
                snapshot.id = UUID()
                snapshot.title += "（冲突保留）"
                snapshot.revision = 1
                snapshot.pdfWritebackSuspended = true
                snapshot.pdfOwnedSourcePaths = []
                snapshot.pdfAnnotationSources = nil
                destination = directory.appendingPathComponent("\(safeFilename(snapshot.title))-\(snapshot.id.uuidString).inkspace.json")
                BoardLassoMemoryProbe.mark(memoryProbe, .conflictEncode, .begin)
                let conflictBytes = try await BoardSavePreparation.encode(snapshot, probe: memoryProbe)
                BoardLassoMemoryProbe.mark(memoryProbe, .conflictEncode, .end, value: UInt64(conflictBytes.count))
                BoardLassoMemoryProbe.mark(memoryProbe, .conflictWrite, .begin)
                fingerprint = try await io.write(conflictBytes, to: destination, expectedFingerprint: nil)
                BoardLassoMemoryProbe.mark(memoryProbe, .conflictWrite, .end)
                document.id = snapshot.id
                document.title = snapshot.title
                library?.annotationOwnersToHide = snapshot.pdfDisplayOwnerIDs
            }
            // Commit editable data before touching source PDFs. A PDF failure must
            // never discard a successful native whiteboard save.
            BoardLassoMemoryProbe.mark(memoryProbe, .nativeCommit, .begin)
            boardURL = destination
            diskFingerprint = fingerprint
            document.revision = snapshot.revision
            document.writerID = writerID
            document.viewport = snapshot.viewport
            document.drawing = snapshot.drawing
            document.webInk = snapshot.webInk
            document.lastInkLocation = snapshot.lastInkLocation
            document.pdfWritebackSuspended = snapshot.pdfWritebackSuspended
            document.pdfAnnotationSources = snapshot.pdfAnnotationSources
            isDirty = generation != savedGeneration
            if !isDirty { document.updatedAt = snapshot.updatedAt }
            savedNative = true
            BoardLassoMemoryProbe.mark(memoryProbe, .nativeCommit, .end)
            // The Obsidian companion can still fail after the native commit.
            // Keep retry state until that write and any PDF work have completed.
            needsLinkRetry = preservingSourcePDFs ? priorLinkRetry : true
            BoardLassoMemoryProbe.mark(memoryProbe, .companion, .begin)
            if let path = relativePath(for: destination) {
                rememberBoard(path)
                await boardCatalog.recordSaved(rootURL: vaultURL, relativePath: path,
                                               title: snapshot.title, boardID: snapshot.id)
                obsidianNoteURL = try await io.ensureObsidianNote(boardURL: destination, relativePath: path, boardID: snapshot.id)
            }
            BoardLassoMemoryProbe.mark(memoryProbe, .companion, .end)
            if shouldSynchronizePDF, snapshot.pdfWritebackSuspended != true, let exported {
                status = String(localized: "白板已保存 · 正在同步 PDF 批注…")
                BoardLassoMemoryProbe.mark(memoryProbe, .pdfLease, .begin)
                let report = try await BoardSavePreparation.withInkMemoryLease {
                    BoardLassoMemoryProbe.mark(memoryProbe, .pdfLease, .end)
                    BoardLassoMemoryProbe.mark(memoryProbe, .pdf, .begin)
                    defer { BoardLassoMemoryProbe.mark(memoryProbe, .pdf, .end) }
                    return await pdfWriteback.synchronize(rootURL: vaultURL, boardID: snapshot.id,
                        items: snapshot.items, drawingData: exported.worldDrawingData,
                        previousSourcePaths: Set(snapshot.pdfOwnedSourcePaths ?? []), createBackupIfMissing: false)
                }
                for failure in report.failures {
                    let problem = failure.errorCode.map { NSError(domain: failure.errorDomain ?? "other", code: $0) }
                    DiagnosticsCenter.shared.record(code: .pdfWritebackFailed, operation: .syncPDF, error: problem)
                }
                snapshot.pdfOwnedSourcePaths = Array(Set(snapshot.pdfOwnedSourcePaths ?? []).union(report.successfulPaths)).sorted()
                snapshot.pdfAnnotationSources = snapshot.pdfAnnotationSources?.map { source in
                    var value = source
                    value.sha256 = report.sourceDigests[source.sourcePath] ?? value.sha256
                    return value
                }
                BoardLassoMemoryProbe.mark(memoryProbe, .pdfEncode, .begin)
                let synchronizedBytes = try await BoardSavePreparation.encode(snapshot, probe: memoryProbe)
                BoardLassoMemoryProbe.mark(memoryProbe, .pdfEncode, .end, value: UInt64(synchronizedBytes.count))
                BoardLassoMemoryProbe.mark(memoryProbe, .pdfWrite, .begin)
                fingerprint = try await io.write(synchronizedBytes, to: destination, expectedFingerprint: fingerprint)
                BoardLassoMemoryProbe.mark(memoryProbe, .pdfWrite, .end)
                diskFingerprint = fingerprint
                document.pdfAnnotationSources = snapshot.pdfAnnotationSources
                document.pdfOwnedSourcePaths = snapshot.pdfOwnedSourcePaths
                if !report.changedPaths.isEmpty { refreshPreviews() }
                needsLinkRetry = !report.failures.isEmpty
                pdfSyncStatus = report.failures.map { "\(($0.sourcePath as NSString).lastPathComponent)：\($0.message)" }.joined(separator: "；")
                if !report.failures.isEmpty {
                    status = String(localized: "白板已保存 · \(report.failures.count) 个 PDF 待重试：\(pdfSyncStatus)")
                } else if let warning = exported.warning { status = warning }
                else if snapshot.items.contains(where: { $0.originalSourcePath != nil }) {
                    status = String(localized: "白板、Obsidian 预览及关联 PDF 批注版已保存 · 等待 iCloud 同步")
                } else { status = String(localized: "白板、Obsidian 预览及原 PDF 批注已保存 · 等待 iCloud 同步") }
            } else {
                needsLinkRetry = preservingSourcePDFs ? priorLinkRetry : (shouldSynchronizePDF && exported == nil)
                if preservingSourcePDFs { status = String(localized:"白板已保存，原 PDF 保持不变。") }
                else if snapshot.pdfWritebackSuspended == true {
                    status = exportWarning ?? String(localized: "已另存冲突白板；此副本暂停回写 PDF，原文件保留。")
                } else {
                    pdfSyncStatus = ""
                    status = exportWarning ?? exported?.warning ?? String(localized: "白板与 Obsidian 预览已保存 · 等待 iCloud 同步")
                }
            }
            // This auxiliary phase cannot downgrade an already durable save.
            BoardLassoMemoryProbe.mark(memoryProbe, .backupLease, .begin)
            _ = try? await BoardSavePreparation.withInkMemoryLease {
                BoardLassoMemoryProbe.mark(memoryProbe, .backupLease, .end)
                BoardLassoMemoryProbe.mark(memoryProbe, .backup, .begin)
                defer { BoardLassoMemoryProbe.mark(memoryProbe, .backup, .end) }
                await backups.capture(document: snapshot, vaultURL: vaultURL, reason: .checkpoint, generation: backupGeneration)
            }
            return true
        } catch VaultWriteError.externalChange {
            BoardLassoMemoryProbe.mark(memoryProbe, .saveCatch, .failed, value: 1)
            DiagnosticsCenter.shared.record(code: .boardConflict, operation: .syncPDF, severity: .warning)
            // A second writer may replace the first durable snapshot while PDF work
            // runs. Preserve in-memory edits and let the normal conflict-save path
            // create a separate board on retry; switching boards must wait.
            changed()
            status = String(localized: "同步时检测到外部修改，正在保留本次白板版本…")
            return false
        } catch {
            BoardLassoMemoryProbe.mark(memoryProbe, .saveCatch, .failed, value: savedNative ? 3 : 2)
            DiagnosticsCenter.shared.record(code: savedNative ? .previewExportFailed : .boardSaveFailed,
                                            operation: savedNative ? .exportPreview : .saveBoard, error: error)
            if savedNative { status = String(localized: "白板已保存，联动待重试：\(error.localizedDescription)") }
            else if hasPendingAutosave { status = String(localized: "自动保存暂未完成，将重试；请保留此白板：\(error.localizedDescription)") }
            else { status = String(localized: "保存失败，内容仍在内存：\(error.localizedDescription)") }
            return savedNative
        }
    }

    func obsidianLink() -> URL? {
        guard let note = obsidianNoteURL, let path = relativePath(for: note), let vaultURL else { return nil }
        var url = URLComponents()
        url.scheme = "obsidian"; url.host = "open"
        url.queryItems = [URLQueryItem(name: "vault", value: vaultURL.lastPathComponent), URLQueryItem(name: "file", value: path)]
        return url.url
    }

    func addItem(_ item: BoardItem) {
        guard canEditBoardContents else { return }
        document.items.append(item)
        selectedIDs = [item.id]
        changed()
    }

    func addItems(_ items: [BoardItem]) {
        guard canEditBoardContents else { return }
        document.items.append(contentsOf: items)
        changed()
    }

    func makeNode(from ink: PKDrawing, rect: CGRect) {
        guard canEditBoardContents else { return }
        let selected = ink.strokes.filter { rect.contains($0.renderBounds) }
        guard !selected.isEmpty else { status = String(localized: "请把完整笔画框入选区"); return }
        let bounds = selected.reduce(CGRect.null) { $0.union($1.renderBounds) }.insetBy(dx: -16, dy: -16)
        let normalized = PKDrawing(strokes: selected).transformed(using: CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
        drawing = PKDrawing(strokes: ink.strokes.filter { !rect.contains($0.renderBounds) })
        addItem(BoardItem(kind: .inkGroup, x: max(0, bounds.minX), y: max(0, bounds.minY),
                          width: max(80, bounds.width), height: max(60, bounds.height),
                          title: String(localized: "手写节点"), inkData: normalized.dataRepresentation()))
        mode = .arrange
    }

    func unpackSelectedInk() {
        guard canEditBoardContents else { return }
        var strokes = drawing.strokes
        let groups = document.items.filter { selectedIDs.contains($0.id) && $0.kind == .inkGroup }
        var restoredIDs = Set<UUID>()
        for item in groups {
            guard let data = item.inkData, let ink = try? PKDrawing(data: data) else { continue }
            strokes += ink.transformed(using: CGAffineTransform(translationX: item.x, y: item.y)).strokes
            restoredIDs.insert(item.id)
        }
        let ids = restoredIDs
        document.items.removeAll { ids.contains($0.id) }
        document.edges.removeAll { ids.contains($0.from) || ids.contains($0.to) }
        drawing = PKDrawing(strokes: strokes)
        selectedIDs = []
        mode = .ink
        changed()
        if restoredIDs.count < groups.count { status = String(localized: "部分手写节点无法解码，已保留原节点。") }
    }

    func connectSelected() {
        guard canEditBoardContents else { return }
        let items = document.items.filter { selectedIDs.contains($0.id) }
            .sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        guard let parent = items.first, items.count >= 2 else { status = String(localized: "请在移动模式依次选中至少两个节点"); return }
        for child in items.dropFirst() where !document.edges.contains(where: { $0.from == parent.id && $0.to == child.id }) {
            document.edges.append(BoardEdge(from: parent.id, to: child.id))
        }
        changed()
    }

    func deleteSelected() {
        guard canEditBoardContents else { return }
        document.items.removeAll { selectedIDs.contains($0.id) }
        document.edges.removeAll { selectedIDs.contains($0.from) || selectedIDs.contains($0.to) }
        selectedIDs = []
        changed()
    }

    func pin(title: String) {
        guard canEditBoardContents, !isBusy, !externalInteractionActive,
              [viewportCenter.x, viewportCenter.y, zoom].allSatisfy(\.isFinite), zoom > 0 else { return }
        let previous = document.pins
        let next = previous + [BoardPin(title: title, x: viewportCenter.x, y: viewportCenter.y, zoom: zoom)]
        readingCanvas?.registerPinEditUndo(previous: previous, expected: next)
        document.pins = next
        changed()
    }

    @discardableResult
    func deletePin(_ id: UUID) -> Bool { deletePins([id]) }

    @discardableResult
    func deletePins(_ ids: Set<UUID>) -> Bool {
        guard canEditBoardContents, !isBusy, !externalInteractionActive else { return false }
        let previous = document.pins, next = document.pins.filter { !ids.contains($0.id) }
        guard next != previous else { return false }
        readingCanvas?.registerPinEditUndo(previous: previous, expected: next)
        document.pins = next
        changed()
        return true
    }

    func jump(to pin: BoardPin) {
        guard [pin.x, pin.y, pin.zoom].allSatisfy(\.isFinite), pin.zoom > 0 else { return }
        zoom = pin.zoom
        viewportCenter = CGPoint(x: pin.x, y: pin.y)
        command = CanvasCommand(action: .jump(viewportCenter, zoom: zoom))
    }

    /// Rendering is presentation-only. In particular, 2,000 thumbnail completions
    /// must not each publish imageRevision or mark the document dirty.
    func requestViewportThumbnail(for item: BoardItem, pixelLength: Int, token: BoardPreviewCancellation,
                                  completion: @escaping (Result<BoardPreviewImage, Error>) -> Void) {
        let session = canvasSessionID, epoch = previewEpoch
        let deliver: (Result<BoardPreviewImage, Error>) -> Void = { [weak self] result in
            guard !token.isCancelled else { return }
            guard let self, self.canvasSessionID == session, self.previewEpoch == epoch else {
                completion(.failure(DocumentLibraryError.cancelled)); return
            }
            completion(result)
        }
        if item.usesFormulaRendering {
            formulaRenderer.render(latexText: item.text ?? item.title, fontSize: item.style?.fontSize ?? 28,
                colorHex: item.style?.textColor ?? "#17232e", backgroundHex: item.style?.fillColor ?? "#FFFFFF") { result in
                    guard !token.isCancelled else { return }
                    switch result {
                    case .success(let image): BoardViewportThumbnailWorker.shared.resize(image, pixelLength: pixelLength, token: token, completion: deliver)
                    case .failure(let error): deliver(.failure(error))
                    }
                }
        } else if item.kind == .inkGroup {
            BoardViewportThumbnailWorker.shared.image(item: item, root: nil, owners: [],
                pixelLength: pixelLength, token: token, completion: deliver)
        } else if let library {
            library.viewportThumbnail(item: item, pixelLength: pixelLength, token: token, completion: deliver)
        } else { deliver(.failure(DocumentLibraryError.missingFile)) }
    }

    func thumbnail(for item: BoardItem) -> UIImage? {
        let styleKey = item.usesFormulaRendering ? (item.style.flatMap { try? JSONEncoder().encode($0).base64EncodedString() } ?? "") : ""
        let key = "\(item.id)-\(item.sourcePath ?? "")-\(item.page ?? 0)-\(item.usesFormulaRendering ? (item.text ?? "") : "")-\(styleKey)"
        if let image = thumbnails.object(forKey: key as NSString) { return image }
        if item.kind == .inkGroup, let data = item.inkData, let ink = try? PKDrawing(data: data) {
            let image = ink.image(from: CGRect(x: 0, y: 0, width: item.width, height: item.height), scale: min(1, 1000 / max(item.width, item.height)))
            cache(image, key: key)
            return image
        }
        guard !requestedThumbnails.contains(key), !failedThumbnails.contains(key) else { return nil }
        if item.usesFormulaRendering {
            requestedThumbnails.insert(key)
            let boardID = document.id
            let epoch = previewEpoch
            formulaRenderer.render(latexText: item.text ?? item.title, fontSize: item.style?.fontSize ?? 28,
                colorHex: item.style?.textColor ?? "#17232e", backgroundHex: item.style?.fillColor ?? "#FFFFFF") { [weak self] result in
                guard let self, self.document.id == boardID, self.previewEpoch == epoch else { return }
                self.requestedThumbnails.remove(key)
                if case let .success(image) = result { self.cache(image, key: key); self.imageRevision += 1 }
                else if case let .failure(error) = result {
                    self.failedThumbnails.insert(key)
                    DiagnosticsCenter.shared.record(code: .documentRenderFailed, operation: .renderDocument, error: error, severity: .warning)
                    self.status = error.localizedDescription
                }
            }
            return nil
        }
        guard item.kind == .pdfPage || item.kind == .document, let library else { return nil }
        requestedThumbnails.insert(key)
        let boardID = document.id
        let epoch = previewEpoch
        library.thumbnail(item: item) { [weak self] result in
            guard let self, self.document.id == boardID, self.previewEpoch == epoch else { return }
            self.requestedThumbnails.remove(key)
            if case let .success(image) = result {
                self.cache(image, key: key)
                self.imageRevision += 1
            } else if case let .failure(error) = result {
                self.failedThumbnails.insert(key)
                if case DocumentLibraryError.cancelled = error { return }
                DiagnosticsCenter.shared.record(code: .documentRenderFailed, operation: .renderDocument, error: error, severity: .warning)
            }
        }
        return nil
    }

    func refreshPreviews() {
        deferredLinkedPreviewRefresh = nil
        previewEpoch += 1
        thumbnails.removeAllObjects()
        requestedThumbnails.removeAll()
        failedThumbnails.removeAll()
        library?.clearCache()
        formulaRenderer.clearCache()
        imageRevision += 1
        status = String(localized: "正在重新读取原文预览")
    }

    private func cache(_ image: UIImage, key: String) {
        let cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0)
        thumbnails.setObject(image, forKey: key as NSString, cost: cost)
    }

    func requestSnapshot(_ image: UIImage) {
        let scale = min(1, 1200 / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let preview = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        document.previewPNG = preview.pngData()
        lastSnapshot = image
        snapshotToken = UUID()
        changed()
    }

    func relativePath(for url: URL) -> String? {
        guard let root = vaultURL?.standardizedFileURL.resolvingSymlinksInPath().path else { return nil }
        let target = url.standardizedFileURL.resolvingSymlinksInPath().path
        guard target.hasPrefix(root + "/") else { return nil }
        return String(target.dropFirst(root.count + 1))
    }

    private func safeFilename(_ title: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:?*\"<>|").union(.controlCharacters)
        let value = String(title.components(separatedBy: invalid).joined(separator: "-").prefix(70))
        return value.isEmpty ? String(localized: "新白板") : value
    }
}

// MARK: - Live child whiteboards
extension BoardStore {
    private func childSessionKey(_ path: String) -> String? {
        guard let root = childRoot.vaultURL,
              let url = VaultPathResolver.resolve(relativePath: path, within: root) else { return nil }
        return url.standardizedFileURL.resolvingSymlinksInPath().path
    }

    func synchronizeChildInputPolicy() {
        let root = childRoot
        let reading = root.isPadReading || root.usesPhoneInterface
        let mode: BoardMode = root.mode == .arrange ? .arrange : .ink
        for child in root.childSessions.values {
            // The parent may synchronize once per frame. Equal assignments would
            // invalidate every embedded canvas despite no input-policy change.
            if child.padReadingEnabled != reading { child.padReadingEnabled = reading }
            if child.phoneMarkupEnabled { child.phoneMarkupEnabled = false }
            if child.savedPens != root.savedPens { child.savedPens = root.savedPens }
            if child.nativePaletteEntries != root.nativePaletteEntries { child.nativePaletteEntries = root.nativePaletteEntries }
            if child.selectedSavedPenID != root.selectedSavedPenID { child.selectedSavedPenID = root.selectedSavedPenID }
            if child.savedPenSelectionRequest != root.savedPenSelectionRequest { child.savedPenSelectionRequest = root.savedPenSelectionRequest }
            if child.mode != mode { child.mode = mode }
        }
    }

    private var automaticRefreshInteractionActive: Bool {
        let root = childRoot
        return root.externalInteractionActive || root.readingCanvas?.snapshotInteractionActive == true
            || root.childSessions.values.contains {
                $0.externalInteractionActive || $0.readingCanvas?.snapshotInteractionActive == true
            }
    }

    func clearChildSessions() {
        for task in childLoadTasks.values { task.cancel() }
        childLoadTasks.removeAll()
        for child in childSessions.values { child.autosaveTask?.cancel() }
        childSessions.removeAll()
        childSessionRevision += 1
    }

    /// Retains the only writable native session for each canonical vault path.
    /// Two visible links therefore cannot race separate copies of the same ink.
    func childStore(for link: BoardChildLink) async -> BoardStore? {
        let root = childRoot
        guard let key = childSessionKey(link.path), let vault = root.vaultURL else {
            status = String(localized: "子白板路径暂不可用，请检查仓库授权。"); return nil
        }
        if let ownURL = root.boardURL, ownURL.standardizedFileURL.resolvingSymlinksInPath().path == key {
            status = String(localized: "不能在白板内部再次展开它自身。"); return nil
        }
        if let existing = root.childSessions[key] {
            guard existing.document.id == link.id else {
                status = String(localized: "子白板标识已变化，原链接已保留，请重新关联。"); return nil
            }
            return existing
        }
        if let loading = root.childLoadTasks[key] { return await loading.value }
        let session = root.canvasSessionID
        let task = Task { @MainActor [weak root] () -> BoardStore? in
            guard let root else { return nil }
            let child = BoardStore()
            child.isEmbeddedSession = true
            child.embeddingRoot = root
            child.vaultURL = vault
            child.library = DocumentLibrary(rootURL: vault)
            guard await child.openBoard(relativePath: link.path), !Task.isCancelled,
                  root.canvasSessionID == session, child.document.id == link.id else {
                root.status = child.document.id == link.id ? child.status : String(localized: "子白板未能载入或标识不一致，原链接已保留。")
                return nil
            }
            child.padReadingEnabled = root.isPadReading || root.usesPhoneInterface
            child.phoneMarkupEnabled = false
            child.mode = root.mode == .arrange ? .arrange : .ink
            root.childSessions[key] = child
            root.childSessionRevision += 1
            return child
        }
        root.childLoadTasks[key] = task
        let result = await task.value
        root.childLoadTasks[key] = nil
        return result
    }

    func flushChildSessions(preservingSourcePDFs: Bool = false) async -> Bool {
        guard !isEmbeddedSession else { return true }
        let sessions = Array(childSessions.values)
        guard !sessions.contains(where: { $0.externalInteractionActive || $0.readingCanvas?.snapshotInteractionActive == true }) else {
            status = String(localized: "请先结束子白板中的书写或拖动，再保存或切换。"); return false
        }
        for child in sessions {
            guard await child.save(preservingSourcePDFs: preservingSourcePDFs) else {
                status = String(localized: "子白板尚未保存：") + child.document.title + " · " + child.status
                return false
            }
        }
        return true
    }

    /// Native conflict saves deliberately retain a new file. Move every live
    /// reference together so the parent never keeps displaying an unlinked copy.
    func reconcileChildSession(_ child: BoardStore) {
        guard let url = child.boardURL, let path = child.relativePath(for: url),
              let old = childSessions.first(where: { $0.value === child }), old.key != url.standardizedFileURL.resolvingSymlinksInPath().path else { return }
        let oldPath = URL(fileURLWithPath: old.key).path
        for parent in [self] + Array(childSessions.values) where parent !== child {
            var changedReferences = false
            for i in parent.document.items.indices {
                guard var links = parent.document.items[i].childBoards else { continue }
                for j in links.indices where parent.childSessionKey(links[j].path) == oldPath {
                    links[j].path = path; links[j].id = child.document.id; links[j].title = child.document.title
                    changedReferences = true
                }
                parent.document.items[i].childBoards = links
            }
            if changedReferences { parent.changed() }
        }
        childSessions[old.key] = nil
        childSessions[url.standardizedFileURL.resolvingSymlinksInPath().path] = child
        childSessionRevision += 1
        status = String(localized: "子白板外部更新发生冲突，本机更改已保留为副本并更新链接：") + path
    }

    @discardableResult
    func createChildBoard(title: String, directory: String, ownerID: UUID? = nil) async -> Bool {
        guard !isBusy, canEditBoardContents, let rootURL = vaultURL else { return false }
        let identity = canvasSessionID
        isBusy = true; defer { isBusy = false }
        guard await flushChildSessions() else { return false }
        let child = BoardStore()
        child.isEmbeddedSession = true; child.embeddingRoot = childRoot
        child.vaultURL = rootURL; child.library = DocumentLibrary(rootURL: rootURL)
        guard await child.newBoard(title: title, directoryPath: directory), canvasSessionID == identity,
              let url = child.boardURL, let path = child.relativePath(for: url), let key = childSessionKey(path) else {
            status = child.status; return false
        }
        childRoot.childSessions[key] = child
        appendChildLink(BoardChildLink(id: child.document.id, path: path, title: child.document.title), ownerID: ownerID)
        status = String(localized: "子白板已创建，展开后可直接编辑：") + path
        return await save()
    }

    @discardableResult
    func linkChildBoard(path: String, ownerID: UUID? = nil) async -> Bool {
        guard !isBusy, canEditBoardContents, let root = vaultURL,
              let url = VaultPathResolver.resolve(relativePath: path, within: root) else { return false }
        let identity = canvasSessionID, parentID = document.id
        isBusy = true; defer { isBusy = false }
        do {
            let loader = BoardReadLoader()
            let loaded = try await loader.load(url)
            guard loaded.document.id != parentID,
                  !(try await childContainsAncestor(path: path, ancestorID: parentID)),
                  canvasSessionID == identity else {
                status = String(localized: "此关联会形成循环，请选择其他白板。"); return false
            }
            appendChildLink(BoardChildLink(id: loaded.document.id, path: path, title: loaded.document.title), ownerID: ownerID)
            status = String(localized: "已关联原子白板，展开编辑会保存回同一文件。")
            return await save()
        } catch {
            status = String(localized: "关联未完成，原白板保留：") + error.localizedDescription
            return false
        }
    }

    private func childContainsAncestor(path: String, ancestorID: UUID) async throws -> Bool {
        guard let root = vaultURL else { throw VaultWriteError.unavailable }
        var pending = [path], visited = Set<String>()
        let loader = BoardReadLoader()
        while let path = pending.popLast() {
            try Task.checkCancellation()
            guard let url = VaultPathResolver.resolve(relativePath: path, within: root) else { throw BoardFormatError.unsafePath }
            let canonical = url.standardizedFileURL.resolvingSymlinksInPath().path
            guard visited.insert(canonical).inserted else { continue }
            guard visited.count <= 512 else { throw BoardFormatError.invalidEdge }
            let board = try await loader.load(url).document
            if board.id == ancestorID { return true }
            pending += board.items.flatMap { ($0.childBoards ?? []).map(\.path) }
        }
        return false
    }

    private func appendChildLink(_ link: BoardChildLink, ownerID: UUID?) {
        if let ownerID, let index = document.items.firstIndex(where: { $0.id == ownerID }) {
            if document.items[index].childBoards?.contains(where: { $0.path == link.path || $0.id == link.id }) == true { return }
            if document.items[index].childBoards == nil { document.items[index].childBoards = [] }
            document.items[index].childBoards?.append(link)
        } else {
            let center = insertionPoint ?? viewportCenter
            let item = BoardItem(kind: .document, x: min(max(0, center.x - 180), document.canvasWidth - 360),
                y: min(max(0, center.y - 60), document.canvasHeight - 120), width: 360, height: 120,
                title: link.title, childBoards: [link])
            document.items.append(item); selectedIDs = [item.id]
        }
        changed()
    }

    func childLink(ownerID: UUID, linkID: UUID) -> BoardChildLink? {
        document.items.first(where: { $0.id == ownerID })?.childBoards?.first(where: { $0.id == linkID })
    }

    func setChildPresentation(ownerID: UUID, linkID: UUID, presentation: BoardChildPresentation) {
        guard !isPadReading, !usesPhoneInterface, !isBusy,
              let i = document.items.firstIndex(where: { $0.id == ownerID }),
              let j = document.items[i].childBoards?.firstIndex(where: { $0.id == linkID }),
              (try? presentation.validate(canvasSize: document.canvasWidth)) != nil,
              document.items[i].childBoards?[j].presentation != presentation else { return }
        document.items[i].childBoards?[j].presentation = presentation
        changed()
    }

    func childContentBounds() -> CGRect {
        var bounds = drawing.strokes.isEmpty ? CGRect.null : drawing.bounds
        for item in document.items {
            bounds = bounds.union(item.rect)
            for link in item.childBoards ?? [] where link.presentation?.expanded == true {
                if let presentation = link.presentation { bounds = bounds.union(presentation.rect) }
            }
        }
        return bounds
    }

    func expandedChild(ownerID: UUID, linkID: UUID, fullContents: Bool = false) async {
        guard !isPadReading, !usesPhoneInterface, !childOperationInProgress,
              let owner = document.items.first(where: { $0.id == ownerID }),
              let link = owner.childBoards?.first(where: { $0.id == linkID }) else { return }
        let session = canvasSessionID
        childOperationInProgress = true; defer { childOperationInProgress = false }
        guard let child = await childStore(for: link), canvasSessionID == session,
              childLink(ownerID: ownerID, linkID: linkID) != nil else { return }
        var presentation = link.presentation
        if presentation == nil || fullContents {
            let origin = presentation.map { CGPoint(x: $0.x, y: $0.y) }
                ?? CGPoint(x: owner.x, y: owner.y + ((owner.childBoards?.count ?? 0) > 1 ? owner.height + 24 : 0))
            presentation = BoardChildLayout.expandedPresentation(childBounds: child.childContentBounds(),
                childViewport: child.document.viewport, origin: origin, canvasSize: document.canvasWidth)
        }
        presentation?.expanded = true
        guard let presentation else { return }
        guard var placed = placeChildInFreeSpace(presentation, ownerID: ownerID, linkID: linkID) else {
            status = String(localized: "当前方向没有足够空白区域，请移动标题卡片后再展开。")
            return
        }
        placed.expanded = true
        setChildPresentation(ownerID: ownerID, linkID: linkID, presentation: placed)
        status = String(localized: "已展开子白板；区域内的修改直接保存到子白板。")
    }

    /// Reserve blank space for a portal without moving any parent object or ink.
    /// In particular a PDF page and its native annotation coordinates stay paired.
    private func placeChildInFreeSpace(_ presentation: BoardChildPresentation, ownerID: UUID, linkID: UUID) -> BoardChildPresentation? {
        var obstacles = document.items.map(\.rect)
        if !drawing.strokes.isEmpty { obstacles.append(drawing.bounds) }
        for owner in document.items {
            for link in owner.childBoards ?? [] where link.presentation?.expanded == true {
                if owner.id == ownerID && link.id == linkID { continue }
                if let p = link.presentation { obstacles.append(p.rect) }
            }
        }
        let space = document.canvasWidth
        var value = presentation
        let startY = value.y
        let rightEdge = obstacles.map { Double($0.maxX) }.max() ?? value.x
        for x in [value.x, rightEdge + 24] where x + value.width <= space {
            value.x = max(0, x); value.y = startY
            for _ in 0...obstacles.count {
                guard value.y + value.height <= space else { break }
                let overlaps = obstacles.filter { $0.insetBy(dx: -24, dy: -24).intersects(value.rect) }
                if overlaps.isEmpty { return value }
                value.y = (overlaps.map { Double($0.maxY) }.max() ?? value.y) + 48
            }
        }
        return nil
    }

    func expandAllChildren() async {
        let links = document.items.flatMap { item in (item.childBoards ?? []).map { (item.id, $0.id) } }
        for (owner, link) in links { await expandedChild(ownerID: owner, linkID: link, fullContents: true) }
        command = CanvasCommand(action: .fitAll)
    }

    func collapseChild(ownerID: UUID, linkID: UUID) async {
        guard !isPadReading, !usesPhoneInterface, let link = childLink(ownerID: ownerID, linkID: linkID),
              var presentation = link.presentation else { return }
        if let child = await childStore(for: link), !(await child.save()) { status = child.status; return }
        presentation.expanded = false
        setChildPresentation(ownerID: ownerID, linkID: linkID, presentation: presentation)
    }

    func collapseAllChildren() async {
        guard await childRoot.flushChildSessions() else { return }
        let links = document.items.flatMap { item in (item.childBoards ?? []).map { (item.id, $0.id) } }
        for (owner, link) in links { await collapseChild(ownerID: owner, linkID: link) }
    }

    func openChildBoard(_ link: BoardChildLink) async {
        let root = childRoot
        let parent = root.boardURL.flatMap { root.relativePath(for: $0) }
        guard await root.flushChildSessions() else { return }
        if await root.openBoard(relativePath: link.path), let parent { root.childNavigationHistory.append(parent) }
    }

    func returnToParentBoard() async {
        guard let path = childNavigationHistory.last else { return }
        if await openBoard(relativePath: path) { childNavigationHistory.removeLast() }
    }
}

extension BoardStore {
    func moveItemWithChildren(index: Int, to point: CGPoint) {
        guard canEditBoardContents, document.items.indices.contains(index) else { return }
        let item = document.items[index]
        var footprint = item.rect
        for link in item.childBoards ?? [] {
            if let presentation = link.presentation { footprint = footprint.union(presentation.rect) }
        }
        let dx = min(max(point.x - item.x, -footprint.minX), document.canvasWidth - footprint.maxX)
        let dy = min(max(point.y - item.y, -footprint.minY), document.canvasHeight - footprint.maxY)
        document.items[index].x += dx; document.items[index].y += dy
        if var links = item.childBoards {
            for i in links.indices where links[i].presentation != nil {
                links[i].presentation!.x += dx; links[i].presentation!.y += dy
            }
            document.items[index].childBoards = links
        }
    }
}


extension BoardStore {
    func refreshChildSessionsIfNeeded() {
        guard !isEmbeddedSession, !refreshingChildren, !isBusy, !automaticRefreshInteractionActive,
              Date().timeIntervalSince(lastChildRefresh) >= 15, !childSessions.isEmpty else { return }
        refreshingChildren = true; lastChildRefresh = Date()
        let identity = canvasSessionID
        Task { [weak self] in
            guard let self else { return }
            defer { self.refreshingChildren = false }
            for child in Array(self.childSessions.values) {
                guard self.canvasSessionID == identity, !self.automaticRefreshInteractionActive else { return }
                _ = await child.refreshExternalChanges()
            }
            guard self.canvasSessionID == identity, !self.automaticRefreshInteractionActive else { return }
            self.synchronizeChildInputPolicy()
        }
    }
}
