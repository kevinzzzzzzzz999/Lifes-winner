import SwiftUI
import UIKit
import UniformTypeIdentifiers
import PencilKit

private struct NewBoardPresentation {
    let id = UUID()
    let source: String?
    let directory: String
    let title: String
}

private struct ExpansionPresentation {
    let id = UUID()
    let boardID: UUID
    let references: [BoardItem]
    let origin: CGPoint
    let usesChosenPoint: Bool
}

private struct PrintRegionPresentation {
    let id = UUID()
    let boardID: UUID
    let region: CGRect
}
private struct BoardExportPresentation {
    let id = UUID()
    let snapshot: BoardDocument
    let rootURL: URL
    let selection: CGRect?
}

private struct InkReplayPresentation {
    let id = UUID()
    let boardID: UUID
    let rootURL: URL?
    let pdfOwnerIDs: Set<UUID>
    let drawing: PKDrawing
    let items: [BoardItem]
    let webInk: BoardWebInk?
    var viewport: BoardViewport? = nil
}

private enum WorkspaceSheet: Identifiable {
    case knowledgeHome
    case scanner, pasteBoard, browser, mediaEditor, ocrPicker, noteExchange
    case exchangeShare(ExchangeShareRequest)
    case ocr(URL, page: Int)
    case inkReplay(InkReplayPresentation)
    case mathWorkspace, study, settings, toolbarCustomization
    case sidebar
    case manageFolder(String, [String])
    case checklist(directory: String, filePath: String?)
    case children(UUID?)
    case folder, boards, library, expandLibrary, text, formula, edit, pins, snapshot
    case editItem(BoardItem)
    case editPen(SavedPen)
    case duplicatePen(SavedPen)
    case addPen, myPens, printPages, backups, diagnostics, reviews, fileManagement, readingContents, mergeBoards
    case reviewDraft(BoardReview)
    case printSetup(PrintRegionPresentation)
    case exportBoard(BoardExportPresentation)
    case newBoard(NewBoardPresentation)
    case expansion(ExpansionPresentation)
    case files(DocumentSelectionAction)
    case source(URL, page: Int?)
    case markdown(String)
    case video(BoardVideoRequest)
    var allowedOnPhone: Bool {
        switch self {
        case .settings, .study, .knowledgeHome, .scanner, .exchangeShare, .exportBoard, .ocrPicker, .ocr, .inkReplay, .browser, .mathWorkspace, .sidebar, .checklist,
             .folder, .boards, .diagnostics, .reviews, .readingContents, .reviewDraft, .snapshot, .video:
            return true
        case .source(let url, _):
            return !url.lastPathComponent.lowercased().hasSuffix(".inkcut.json")
        default: return false
        }
    }

    var id: String {
        switch self {
        case .editItem(let item): "edit-item-" + item.id.uuidString
        case .editPen(let pen): "edit-pen-" + pen.id.uuidString
        case .duplicatePen(let pen): "copy-pen-" + pen.id.uuidString
        case .checklist(let directory, let filePath): "checklist-" + (filePath ?? directory)
        case .manageFolder(let path, let selection): "manage-" + path + "-" + selection.joined(separator: "|")
        case .reviewDraft(let review): "review-" + review.id.uuidString
        case .printSetup(let request): "print-" + request.id.uuidString
        case .exportBoard(let request): "export-" + request.id.uuidString
        case .newBoard(let request): "new-" + request.id.uuidString
        case .expansion(let request): "expand-" + request.id.uuidString
        case .inkReplay(let request): "inkReplay-" + request.id.uuidString
        case .exchangeShare(let request): "exchangeShare-" + request.id.uuidString
        case .ocr(let url, let page): "ocr-\(url.absoluteString)-\(page)"
        case .source(let url, let page): "source-\(url.absoluteString)-\(page ?? 0)"
        case .markdown(let path): "markdown-" + path
        case .video(let request): "video-" + request.id.uuidString
        default: String(describing: self)
        }
    }
}

private enum PadWorkspaceSidePanel { case reviews, assistant, browser }

private enum AIWorkspacePresentation: String, Identifiable {
    case webpage, api
    var id: String { rawValue }
}

private struct DeletedSelection {
    let boardID: UUID
    let items: [BoardItem]
    let edges: [BoardEdge]
}

struct InkSpaceWorkspaceView: View {
    @Bindable var store: BoardStore
    var openBoardRequestID: UUID? = nil
    var onShowKnowledgeHome: (() -> Void)? = nil
    var isCoveredByHome = false
    var homeRequest: PadHomeWorkspaceRequest? = nil
    var onHomeRequestHandled: ((UUID) -> Void)? = nil
    @State private var mergePlacement: BoardMergePlacementSession?
    @State private var mergeOpening = false
    @State private var lastBoardMerge: BoardMergeUndoSession?
    @State private var mergeUndoWorking = false
    @State private var mergeNotice: String?
    @State private var sheet: WorkspaceSheet?
    @State private var pdfSourceReference: PDFSourceReference?
    @State private var inlineReplay: InkReplayPresentation?
    @State private var replayPreviousMode: BoardMode = .ink
    @State private var replayPreviouslyReading = true
    @State private var nativePaletteSheetSessionID: UUID?
    @State private var nextSheet: WorkspaceSheet?
    @State private var studySession = StudySession()
    @State private var studyReturnBoardID: UUID?
    @State private var pendingPlacementSheet: WorkspaceSheet?
    @State private var pendingPhoneReviewPlacement = false
    @State private var pendingFileAction: DocumentSelectionAction?
    @State private var filePickerDirectory: URL?
    @State private var pendingLibraryDocuments: [VaultDocument] = []
    @State private var pendingSidebarDocuments: [VaultDocument] = []
    @State private var sidebarRefreshID = UUID()
    @AppStorage("padWorkspace.sidebarVisible") private var sidebarVisible = true
    @AppStorage("padWorkspace.editingToolsExpanded47") private var editingToolsExpanded = false
    @AppStorage(BoardToolbarVisibility.preferenceKey) private var boardToolbarHiddenMask = 0
    @State private var workspaceWidth: CGFloat = 0
    @State private var importTask: Task<Void, Never>?
    @State private var importProgress = String(localized: "正在读取文档…")
    @State private var chatSession = ChatGPTWebSession()
    @State private var browserSession = EmbeddedBrowserSession()
    @State private var sidePanel: PadWorkspaceSidePanel?
    @State private var calculatorVisible = false
    @State private var temporaryCapture = TemporaryBoardCapture()
    @State private var translation = PDFTranslationSession()
    @State private var translationSource: BoardPDFTranslationSource?
    @State private var aiPresentation: AIWorkspacePresentation?
    @State private var nextAIPresentation: AIWorkspacePresentation?
    @State private var captureAfterAIDismiss = false
    @State private var returnToFullScreenAfterCapture = false
    @State private var returnToSidebarAfterAI = false
    @State private var showsSyncDetails = false
    @State private var expansionWarnings = ""
    @State private var showsExpansionWarnings = false
    @State private var confirmsDelete = false
    @State private var lastDeletion: DeletedSelection?
    @State private var pendingCatalogReconnect: BoardCatalogEntry?
    @State private var activeHomeRequestID: UUID?
    @State private var consumedHomeRequestID: UUID?
    @State private var fallbackHomeRequest: PadHomeWorkspaceRequest?
    @State private var returnHomeAfterVaultSelection = false
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.workspaceWindowActions) private var workspaceWindows

    private var toolbarVisibility: BoardToolbarVisibility { BoardToolbarVisibility(hiddenMask: boardToolbarHiddenMask) }

    private var browserSidebarVisible: Bool {
        get { sidePanel == .browser }
        nonmutating set { if newValue { sidePanel = .browser } else if sidePanel == .browser { sidePanel = nil } }
    }
    private var aiSidebarVisible: Bool {
        get { sidePanel == .assistant }
        nonmutating set { if newValue { sidePanel = .assistant } else if sidePanel == .assistant { sidePanel = nil } }
    }

    private var selectedItems: [BoardItem] {
        store.document.items.filter { store.selectedIDs.contains($0.id) }
    }

    private var workspace: some View {
        NavigationStack {
            Group {
                if store.vaultURL == nil {
                    welcome
                } else {
                    NativeBoardCanvas(store: store, onOpenVideo: { sheet = .video($0) }, temporaryCapture: temporaryCapture, onEditItem: { item in if canEditBoardContents { sheet = .editItem(item) } }, onOpenWeb: { openBrowser(url: $0) }, allowsTextSelection: inlineReplay == nil && mergePlacement == nil, mergePlacement: mergePlacement, hidesCanvasAccessibility: isCoveredByHome || inlineReplay != nil || sheet != nil)
                        .id(store.canvasSessionID)
                        .allowsHitTesting(inlineReplay == nil)
                        .accessibilityHidden(isCoveredByHome || inlineReplay != nil || sheet != nil)
                        .overlay {
                            if let replay = inlineReplay {
                                InkReplayView(drawing: replay.drawing, items: replay.items, webInk: replay.webInk,
                                    boardID: replay.boardID, rootURL: replay.rootURL, pdfOwnerIDs: replay.pdfOwnerIDs, embedded: true,
                                    initialViewport: replay.viewport, onClose: closeInlineReplay)
                                    .id(replay.id)
                            }
                        }
                        .overlay(alignment: .topLeading) {
                            if !store.usesPhoneInterface && !store.isPadReading && !store.reviewModeEnabled && [.frame, .paper].contains(store.mode) { modeHint }
                        }
                        .overlay {
                            if temporaryCapture.isSelecting {
                                TemporaryBoardCaptureOverlay(capture: temporaryCapture, onFinish: finishChatCapture)
                            }
                        }
                        .overlay { if store.isPadReading && !store.usesPhoneInterface { PDFTranslationOverlay(session: translation) } }
                        // PencilKit's window-level palette floats at the bottom.
                        // Keep board controls below the navigation bar; the existing
                        // horizontal scroll keeps them reachable in either orientation.
                        .safeAreaInset(edge: .top, spacing: 0) {
                            VStack(spacing: 0) {
                                if let placement = mergePlacement {
                                    mergePlacementControls(placement)
                                } else if !store.usesPhoneInterface {
                                    if store.isPadReading && inlineReplay == nil && !store.reviewModeEnabled && toolbarVisibility.isVisible(.readAloud) { BoardReadAloudControls(store: store) }
                                    if store.reviewModeEnabled { ReviewControls(store: store, onList: { showReviewList() }) } else { boardTools }
                                }
                                if !store.usesPhoneInterface && !store.externalRefreshStatus.isEmpty {
                                    Text(store.externalRefreshStatus).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 6)
                                        .background(.regularMaterial).accessibilityIdentifier("board.refreshStatus")
                                }
                            }
                        }
                        .safeAreaInset(edge: .bottom, spacing: 0) {
                            if mergePlacement == nil, let receipt = lastBoardMerge, receipt.rootURL == store.vaultURL,
                               store.boardURL.flatMap({ store.relativePath(for: $0) }) == receipt.result.outputPath {
                                mergeUndoControls(receipt)
                            }
                            if store.usesPhoneInterface {
                                if inlineReplay != nil { EmptyView() }
                                else if store.reviewModeEnabled { ReviewControls(store: store, onList: { sheet = .reviews }, onPlace: { beginPhoneReviewPlacement() }) }
                                else {
                                    VStack(spacing: 0) {
                                    BoardReadAloudControls(store: store)
                                    PhoneBoardControls(store: store,
                                    onStatus: { showsSyncDetails = true },
                                    onReview: { beginPhoneReviewPlacement() },
                                    onHighlight: { beginPhoneHighlight() },
                                    onReviewList: { sheet = .reviews }, onScan: { sheet = .scanner },
                                    onCancelPlacement: { cancelPhonePlacement() })
                                    }
                                }
                            }
                        }
                }
            }
            .disabled(store.isBusy)
            .navigationTitle(store.vaultURL == nil ? "人生赢家" : store.document.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if mergePlacement == nil && !mergeOpening { workspaceToolbar }
                else {
                    ToolbarItem(placement: .principal) { Text(String(localized: "放置合并内容")).font(.headline) }
                }
            }
            .tint(PadDesign.accent)
            .overlay {
                if store.isBusy {
                    VStack(spacing: 16) {
                        ProgressView(importTask != nil ? importProgress : (store.isSaving ? store.status : (store.busyOperationTitle ?? String(localized: "正在处理，请稍候…"))))
                            .accessibilityIdentifier("workspace.busy")
                        if importTask != nil { Button(String(localized: "取消")) { importTask?.cancel() }.buttonStyle(.bordered) }
                    }
                    .padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
                }
            }
        }
    }

    private func mergePlacementControls(_ placement: BoardMergePlacementSession) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(String(localized: "点击白板设定左上角；可平移、缩放后再次点选。"))
                .font(.subheadline.weight(.medium))
            Text("\(placement.preview.sourceTitle) · \(placement.preview.counts.nativeStrokes) 笔 · \(placement.preview.counts.items) 个资料块")
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            if let message = placement.errorMessage {
                Text(message).font(.caption).foregroundStyle(.red).accessibilityIdentifier("board.merge.placement.error")
            } else if !placement.fitsCanvas {
                Text(String(localized: "整块内容超出白板边缘，请重新选位置。"))
                    .font(.caption).foregroundStyle(.red)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { mergePlacementButtons(placement) }
                VStack(alignment: .leading, spacing: 8) { mergePlacementButtons(placement) }
            }
            .buttonStyle(.bordered).controlSize(.large)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial)
        .disabled(placement.working || store.isBusy)
    }

    @ViewBuilder private func mergePlacementButtons(_ placement: BoardMergePlacementSession) -> some View {
        Button(String(localized: "取消"), systemImage: "xmark") { Task { await cancelBoardMergePlacement(placement) } }
            .accessibilityIdentifier("board.merge.placement.cancel")
        Button(String(localized: "放在视野中央"), systemImage: "scope") {
            let size = placement.bounds.size
            placement.choose(CGPoint(x: max(0, store.viewportCenter.x - size.width / 2),
                                     y: max(0, store.viewportCenter.y - size.height / 2)))
        }.accessibilityIdentifier("board.merge.placement.center")
        Button(String(localized: "查看整块范围"), systemImage: "arrow.up.left.and.arrow.down.right") {
            store.command = CanvasCommand(action: .fitRegion(placement.bounds))
        }.accessibilityIdentifier("board.merge.placement.fit")
        Button { store.command = CanvasCommand(action: .zoomOut) } label: { Image(systemName: "minus.magnifyingglass") }
            .accessibilityLabel(String(localized: "缩小")).accessibilityIdentifier("board.merge.placement.zoomOut")
        Button { store.command = CanvasCommand(action: .zoomIn) } label: { Image(systemName: "plus.magnifyingglass") }
            .accessibilityLabel(String(localized: "放大")).accessibilityIdentifier("board.merge.placement.zoomIn")
        Button(String(localized: "确认放置"), systemImage: "checkmark") { Task { await commitBoardMergePlacement(placement) } }
            .buttonStyle(.borderedProminent).disabled(!placement.canCommit)
            .accessibilityIdentifier("board.merge.placement.confirm")
    }

    private func mergeUndoControls(_ receipt: BoardMergeUndoSession) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(PadDesign.accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(String(localized: "已合并，源白板保留")).font(.subheadline.weight(.medium))
                if let mergeNotice { Text(mergeNotice).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            Button(String(localized: "撤回本次合并"), systemImage: "arrow.uturn.backward") {
                Task { await undoBoardMerge(receipt) }
            }.buttonStyle(.bordered).disabled(store.isBusy || mergeUndoWorking)
                .accessibilityIdentifier("board.merge.undo")
            Button { lastBoardMerge = nil; mergeNotice = nil } label: { Image(systemName: "xmark").frame(width: 32, height: 36) }
                .accessibilityLabel(String(localized: "收起合并提示")).accessibilityIdentifier("board.merge.undo.dismiss")
        }.padding(12).background(.regularMaterial)
    }

    @MainActor private func beginBoardMergePlacement(service: BoardMergeService, preview: BoardMergePreview) async {
        guard mergePlacement == nil, !mergeOpening, let root = store.vaultURL,
              let currentPath = store.boardURL.flatMap({ store.relativePath(for: $0) }),
              !store.isBusy, !store.isDirty else { return }
        let oldMode = store.mode, wasReading = store.isPadReading
        let oldCenter = store.viewportCenter, oldZoom = store.zoom
        mergeOpening = true; defer { mergeOpening = false }
        pendingPlacementSheet = nil; pendingSidebarDocuments = []; pendingLibraryDocuments = []
        pendingPhoneReviewPlacement = false; store.insertionPoint = nil
        if currentPath != preview.targetPath { await store.openBoard(relativePath: preview.targetPath) }
        guard store.vaultURL == root, store.boardURL.flatMap({ store.relativePath(for: $0) }) == preview.targetPath,
              !store.isBusy, !store.isDirty else {
            store.status = String(localized: "目标白板没有完整打开，未进行合并。请重新选择。"); return
        }
        store.beginPadEditing(); store.mode = .place
        mergePlacement = BoardMergePlacementSession(service: service, preview: preview, canvasSessionID: store.canvasSessionID,
            rootURL: root, returnPath: currentPath, previousMode: oldMode, previouslyReading: wasReading,
            previousCenter: oldCenter, previousZoom: oldZoom)
        store.command = CanvasCommand(action: .fitRegion(preview.placedBounds))
        store.status = String(localized: "预览整块合并范围；点击设置左上角，再确认放置。")
    }

    @MainActor private func cancelBoardMergePlacement(_ placement: BoardMergePlacementSession) async {
        guard mergePlacement?.id == placement.id, !placement.working else { return }
        placement.working = true
        await placement.service.discard()
        mergePlacement = nil
        store.insertionPoint = nil; store.mode = .ink
        if store.vaultURL == placement.rootURL {
            if store.boardURL.flatMap({ store.relativePath(for: $0) }) != placement.returnPath {
                await store.openBoard(relativePath: placement.returnPath)
            }
            if store.boardURL.flatMap({ store.relativePath(for: $0) }) == placement.returnPath {
                await restoreMergeInput(placement)
                store.command = CanvasCommand(action: .restoreViewport(placement.previousCenter, zoom: placement.previousZoom))
            }
        }
        store.status = String(localized: "已取消合并，未写入目标白板。")
    }

    @MainActor private func commitBoardMergePlacement(_ placement: BoardMergePlacementSession) async {
        guard mergePlacement?.id == placement.id, placement.canCommit, let point = placement.position else { return }
        placement.working = true; placement.errorMessage = nil
        defer { placement.working = false }
        do {
            guard store.vaultURL == placement.rootURL, store.canvasSessionID == placement.canvasSessionID,
                  store.boardURL.flatMap({ store.relativePath(for: $0) }) == placement.preview.targetPath else { throw BoardMergeError.changed }
            let fresh = try await store.prepareBoardMerge(service: placement.service,
                sourcePath: placement.preview.sourcePath, targetPath: placement.preview.targetPath,
                placement: placement.preview.placement, mode: placement.preview.mode, position: point)
            guard fresh.sourceSHA256 == placement.preview.sourceSHA256,
                  fresh.targetSHA256 == placement.preview.targetSHA256 else { throw BoardMergeError.changed }
            let result = try await store.commitBoardMerge(service: placement.service, preview: fresh)
            mergePlacement = nil; store.insertionPoint = nil
            lastBoardMerge = BoardMergeUndoSession(service: placement.service, result: result, rootURL: placement.rootURL)
            mergeNotice = String(localized: "放错可立即撤回；若已有新修改，会停止撤回以免丢失。")
            await restoreMergeInput(placement)
            store.command = CanvasCommand(action: .fitRegion(result.importedBounds))
        } catch { placement.errorMessage = error.localizedDescription }
    }

    @MainActor private func restoreMergeInput(_ placement: BoardMergePlacementSession) async {
        if placement.previouslyReading { _ = await store.beginPadReading() }
        else { store.beginPadEditing(); store.mode = placement.previousMode == .place ? .arrange : placement.previousMode }
    }

    @MainActor private func undoBoardMerge(_ receipt: BoardMergeUndoSession) async {
        guard !mergeUndoWorking, receipt.rootURL == store.vaultURL else { return }
        mergeUndoWorking = true; defer { mergeUndoWorking = false }
        do {
            _ = try await store.undoLastBoardMerge(service: receipt.service, result: receipt.result)
            lastBoardMerge = nil; mergeNotice = nil
        } catch { mergeNotice = error.localizedDescription }
    }

    private var aiWorkspace: some View {
        GeometryReader { geometry in
            let layout = PadWorkspacePanelLayout(width: geometry.size.width, wantsMaterials: sidebarVisible, wantsTool: hasSideTool)
            HStack(spacing: 0) {
                if !store.usesPhoneInterface, horizontalSizeClass != .compact, layout.showsMaterials, let root = store.vaultURL {
                    sidebar(rootURL: root)
                        .frame(width: layout.materialWidth)
                    Divider()
                }
                workspace.frame(maxWidth: .infinity, maxHeight: .infinity)
                if hasSideTool && layout.docksTool {
                    Divider()
                    sideToolPanel.frame(width: layout.toolWidth)
                }
            }
            .onAppear { workspaceWidth = geometry.size.width }
            .onChange(of: geometry.size.width) { _, width in workspaceWidth = width }
        }
    }

    private var hasSideTool: Bool {
        !store.usesPhoneInterface && sidePanel != nil
            && !(sidePanel == .assistant && aiPresentation != nil)
    }

    @ViewBuilder private var sideToolPanel: some View {
        switch sidePanel {
        case .reviews:
            PadReviewSidebarView(reviews: store.reviews, boardTitle: store.document.title,
                onJump: { store.jumpToReview($0) }, onAdd: beginPadReview,
                onClose: { sidePanel = nil })
        case .browser: browserPanel(fullScreen: false)
        case .assistant: chatPanel(fullScreen: false)
        case nil: EmptyView()
        }
    }

    private func usesFullScreenPresentation(_ route: WorkspaceSheet?) -> Bool {
        if case .study = route { return true }
        if case .browser = route { return true }
        if case .mediaEditor = route { return true }
        if case .source(let url, _) = route, url.lastPathComponent.lowercased().hasSuffix(".inkcut.json") { return true }
        if case .knowledgeHome = route { return true }
        if case .mathWorkspace = route { return true }
        guard !store.usesPhoneInterface, case .source(let url, _) = route else { return false }
        let fileExtension = url.pathExtension.lowercased()
        return fileExtension == "pdf" || DocumentLibrary.officeExtensions.contains(fileExtension)
    }
    private var ordinarySheet: Binding<WorkspaceSheet?> {
        Binding(get: { usesFullScreenPresentation(sheet) ? nil : sheet }, set: { value in
            if let value { sheet = value } else if !usesFullScreenPresentation(sheet) { sheet = nil }
        })
    }
    private var pdfWorkspacePresentation: Binding<WorkspaceSheet?> {
        Binding(get: { usesFullScreenPresentation(sheet) ? sheet : nil }, set: { value in
            if let value { sheet = value } else if usesFullScreenPresentation(sheet) { sheet = nil }
        })
    }
    private func workspaceSheetDidDismiss() {
        let paletteSession = nativePaletteSheetSessionID
        nativePaletteSheetSessionID = nil
        sidebarRefreshID = UUID()
        if let next = nextSheet { nextSheet = nil; sheet = next }
        else if let action = pendingFileAction { pendingFileAction = nil; sheet = .files(action) }
        else {
            pendingCatalogReconnect = nil
            if returnHomeAfterVaultSelection {
                returnHomeAfterVaultSelection = false
                showKnowledgeHome()
            } else { processHomeRequest() }
        }
        if let paletteSession, paletteSession == store.canvasSessionID, sheet == nil,
           !store.usesPhoneInterface, !store.isPadReading, !store.reviewModeEnabled,
           !store.isBusy, store.mode == .ink {
            store.command = CanvasCommand(action: .showPalette)
        }
    }

    private func presentNativePaletteEditor() {
        guard !store.usesPhoneInterface, !store.isPadReading, !store.reviewModeEnabled,
              !store.isBusy, sheet == nil else { return }
        nativePaletteSheetSessionID = store.canvasSessionID
        sheet = .myPens
    }

    private var presentedWorkspace: some View {
        aiWorkspace
            .overlay { FloatingCalculatorOverlay(visible: $calculatorVisible) }
            .safeAreaInset(edge: .bottom) {
                if studyReturnBoardID == store.document.id, sheet == nil {
                    Button(String(localized: "返回复习"), systemImage: "rectangle.stack") { studyReturnBoardID = nil; sheet = .study }
                        .buttonStyle(.borderedProminent).frame(minHeight: 44).padding(8).background(.regularMaterial)
                        .accessibilityIdentifier("study.return")
                }
            }
            .sheet(item: ordinarySheet, onDismiss: workspaceSheetDidDismiss) { route in sheetView(route) }
            .fullScreenCover(item: pdfWorkspacePresentation, onDismiss: workspaceSheetDidDismiss) { route in sheetView(route) }
            .alert(String(localized: "PDF 批注尚未同步"), isPresented: $showsSyncDetails) {
                Button(String(localized: "知道了"), role: .cancel) {}
            } message: { Text(store.pdfSyncStatus) }
            .alert(String(localized: "文档展开提示"), isPresented: $showsExpansionWarnings) {
                Button(String(localized: "知道了"), role: .cancel) {}
            } message: { Text(expansionWarnings) }
            .fullScreenCover(item: $aiPresentation, onDismiss: aiDidDismiss) { presentation in
                switch presentation {
                case .webpage: chatPanel(fullScreen: true)
                case .api: AIWorkspaceView(store: store)
                }
            }
            .confirmationDialog(String(localized: "删除选中的 \(selectedItems.count) 个节点？"), isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button(String(localized: "删除节点"), role: .destructive) { deleteSelection() }
                Button(String(localized: "取消"), role: .cancel) {}
            } message: {
                Text(String(localized: "同时移除相关连线。仓库原文档保留，可用“恢复上次删除”恢复这些节点。"))
            }
    }

    private var lifecycleWorkspace: some View {
        presentedWorkspace
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    await store.backgroundRefresh.retryForegroundRefresh(store: store)
                    if !store.backgroundRefresh.foregroundRefreshPending {
                        await store.refreshExternalChanges()
                    }
                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                }
            }
            .onChange(of: store.canRefreshForLifecycle) { _, ready in
                if ready { Task { await store.backgroundRefresh.retryForegroundRefresh(store: store) } }
            }
            .onChange(of: sheet?.id) { _, _ in updateAIRefreshPause() }
            .onChange(of: aiPresentation) { _, _ in updateAIRefreshPause() }
            .onChange(of: temporaryCapture.isSelecting) { _, _ in updateAIRefreshPause() }
            .onChange(of: translation.capture.isSelecting) { _, _ in updateAIRefreshPause() }
            .onChange(of: translation.showsSettings) { _, visible in
                updateAIRefreshPause()
                if !visible { processHomeRequest() }
            }
            .onChange(of: store.isPadReading) { _, reading in if !reading { translation.close() } }
            .onChange(of: store.externalInteractionActive) { _, active in
                if active && temporaryCapture.isSelecting {
                    temporaryCapture.rejectActiveInteraction()
                    returnToFullScreenAfterCapture = false
                }
            }
            .onDisappear { translation.close(); translationSource = nil }
            .onChange(of: store.canvasSessionID) { _, _ in
                temporaryCapture.clear(); captureAfterAIDismiss = false; returnToFullScreenAfterCapture = false
                translation.close(); translationSource = nil
            }
    }

    var body: some View {
        lifecycleWorkspace
            .task { presentRequestedBoard() }
            .task(id: homeRequest?.id) { processHomeRequest() }
            .task(id: fallbackHomeRequest?.id) { processHomeRequest() }
            .onChange(of: sidebarCanOpen) { _, ready in if ready { processHomeRequest() } }
            .onChange(of: openBoardRequestID) { _, _ in
                if case .knowledgeHome = sheet { sheet = nil }
            }
            .onChange(of: store.nativePenEditorRequest?.id) { _, requestID in
                guard requestID != nil, !store.isPadReading, !store.reviewModeEnabled, sheet == nil,
                      let penID = store.nativePenEditorRequest?.penID,
                      let pen = store.savedPens.first(where: { $0.id == penID }) else { return }
                nativePaletteSheetSessionID = store.canvasSessionID
                sheet = .editPen(pen)
            }
            .onChange(of: store.nativePaletteEditorRequestID) { _, request in
                if request != nil { presentNativePaletteEditor() }
            }
            .task(id: "\(store.canvasSessionID)-\(store.document.id)") { await store.attachReviews() }
            .onChange(of: store.reviews.draft?.id) { _, _ in
                guard let draft = store.reviews.draft else { return }
                if draft.isHighlight {
                    let session = store.canvasSessionID
                    Task {
                        let saved = await store.reviews.addDraft(comment: "")
                        guard store.canvasSessionID == session else { return }
                        if saved { store.reviews.captureEnabled = store.reviewModeEnabled }
                        else if store.reviews.draft?.id == draft.id { sheet = .reviewDraft(draft) }
                    }
                } else { sheet = .reviewDraft(draft) }
            }
            .onChange(of: store.snapshotToken) { _, _ in
                if store.lastSnapshot != nil { sheet = .snapshot }
            }
            .onChange(of: store.document.id) { _, _ in
                studyReturnBoardID = nil
                inlineReplay = nil
                pdfSourceReference = nil
                importTask?.cancel()
                nextSheet = nil
                store.selectedPrintFrameID = nil
                store.capturedPrintRegion = nil
                store.printTool = .select
                lastDeletion = nil
                pendingPlacementSheet = nil
                pendingPhoneReviewPlacement = false
                pendingFileAction = nil
                pendingLibraryDocuments = []
                pendingSidebarDocuments = []
                sheet = nil
            }
            .onChange(of: store.insertionPoint) { _, point in
                if let point, !pendingSidebarDocuments.isEmpty {
                    let documents = pendingSidebarDocuments
                    pendingSidebarDocuments = []
                    addDocuments(documents, action: .add, origin: point)
                } else if let point, pendingPhoneReviewPlacement {
                    pendingPhoneReviewPlacement = false
                    store.insertionPoint = nil
                    Task { await store.beginTemporaryReview(at: point) }
                } else if point != nil, let route = pendingPlacementSheet {
                    pendingPlacementSheet = nil
                    sheet = route
                }
            }
            .onChange(of: store.printRegionRequest) { _, _ in
                guard let region = store.capturedPrintRegion else { return }
                if store.capturedRegionForExport { showExport(selection: region) }
                else { sheet = .printSetup(PrintRegionPresentation(boardID: store.document.id, region: region)) }
            }
            .onChange(of: store.newBoardRequestID) { _, _ in presentRequestedBoard() }
            .onChange(of: store.isBusy) { _, busy in if !busy { presentRequestedBoard() } }
            .onChange(of: store.vaultURL) { _, _ in presentRequestedBoard() }
    }

    private func showKnowledgeHome() {
        if let onShowKnowledgeHome { onShowKnowledgeHome() }
        else { sheet = .knowledgeHome }
    }

    private func processHomeRequest() {
        guard let request = homeRequest ?? fallbackHomeRequest, activeHomeRequestID == nil,
              request.id != consumedHomeRequestID else { return }
        let decision = PadHomeRouteGate.decision(expectedRoot: request.expectedRoot,
            currentRoot: store.vaultURL?.standardizedFileURL.path,
            busy: store.isBusy || store.isSaving,
            hasPresentationOrDraft: sheet != nil || aiPresentation != nil || !sidebarCanOpen || translation.showsSettings)
        switch decision {
        case .waitForCurrentWork:
            if !store.isBusy && !store.isSaving {
                store.status = String(localized: "首页选择已保留，请先完成或关闭当前编辑，再继续打开。")
            }
            return
        case .staleVault:
            consumedHomeRequestID = request.id
            onHomeRequestHandled?(request.id)
            if fallbackHomeRequest?.id == request.id { fallbackHomeRequest = nil }
            store.status = String(localized: "资料文件夹已更换，请返回首页重新选择。")
            return
        case .ready: break
        }
        // Presentation callbacks may retain an earlier View value. Remember
        // consumption in State so dismissing that sheet cannot replay its route.
        activeHomeRequestID = request.id
        consumedHomeRequestID = request.id
        onHomeRequestHandled?(request.id)
        if fallbackHomeRequest?.id == request.id { fallbackHomeRequest = nil }
        Task {
            defer { activeHomeRequestID = nil }
            guard !store.usesPhoneInterface || request.action.allowedOnPhone else {
                store.status = String(localized: "请在 iPad 上编辑白板")
                return
            }
            switch request.action {
            case .browseFolder:
                sheet = .sidebar
            case .recent(let entry):
                if entry.kind == .folder { sheet = .sidebar }
                else { _ = await openSidebarEntry(ManagedVaultEntry(path: entry.relativePath, isDirectory: false)) }
            case .chooseVault:
                pendingCatalogReconnect = nil
                returnHomeAfterVaultSelection = true
                sheet = .folder
            case .boardLibrary:
                sheet = .boards
            case .calculator:
                calculatorVisible = true
            case .readingContents:
                sheet = .readingContents
            case .scanner:
                sheet = .scanner
            case .noteExchange:
                sheet = .noteExchange
            case .ocr:
                sheet = .ocrPicker
            case .inkReplay:
                showInkReplay()
            case .phoneReview:
                beginPhoneReviewPlacement()
            case .reviewList:
                showReviewList()
            case .checklist(let directory):
                sheet = .checklist(directory: directory, filePath: nil)
            case .browser:
                browserSidebarVisible = false
                openBrowser()
            case .mediaEditor:
                sheet = .mediaEditor
            case .assistant:
                aiSidebarVisible = false
                openChatGPT()
            case .open(let entry):
                _ = await openSidebarEntry(entry)
            case .add(let entries):
                store.beginPadEditing()
                beginSidebarAdd(entries)
            case .newBoard(let directory):
                store.beginPadEditing()
                presentFromSidebar(.newBoard(NewBoardPresentation(source: nil, directory: directory, title: "")))
            case .manage(let directory, let selectedPaths):
                store.beginPadEditing()
                presentFromSidebar(.manageFolder(directory, selectedPaths))
            }
        }
    }

    private var canCaptureForChat: Bool {
        inlineReplay == nil && store.vaultURL != nil && !store.isBusy && !store.externalInteractionActive && sheet == nil && pendingPlacementSheet == nil
            && !pendingPhoneReviewPlacement && !store.reviewModeEnabled && store.mode != .place
    }

    private func chatPanel(fullScreen: Bool) -> some View {
        ChatGPTWebPanel(session: chatSession, capture: temporaryCapture, fullScreen: fullScreen,
                       canCapture: canCaptureForChat,
                       onCapture: { beginChatCapture(fromFullScreen: fullScreen) },
                       onFullScreen: {
                           returnToSidebarAfterAI = true; aiSidebarVisible = false; aiPresentation = .webpage
                       }, onClose: {
                           temporaryCapture.cancel()
                           if fullScreen { aiPresentation = nil } else { aiSidebarVisible = false }
                       }, onAPI: {
                           temporaryCapture.cancel()
                           if fullScreen { nextAIPresentation = .api; aiPresentation = nil }
                           else { returnToSidebarAfterAI = true; aiSidebarVisible = false; aiPresentation = .api }
                       })
    }

    private func showInkReplay() {
        guard inlineReplay == nil, store.boardURL != nil, sidebarCanOpen else { return }
        guard store.readingCanvas?.prepareForReading() != false else {
            store.status = String(localized: "请先抬起笔或结束拖动，再打开笔迹回放。")
            return
        }
        let boardID = store.document.id
        let wasReading = store.isPadReading
        let previousMode = store.mode
        Task { @MainActor in
            if !store.usesPhoneInterface {
                guard await store.beginPadReading() else { return }
            }
            guard boardID == store.document.id, inlineReplay == nil else { return }
            replayPreviouslyReading = wasReading; replayPreviousMode = previousMode
            translation.capture.cancel()
            inlineReplay = InkReplayPresentation(boardID: boardID, rootURL: store.vaultURL, pdfOwnerIDs: store.document.pdfDisplayOwnerIDs,
                drawing: store.drawing, items: store.document.items, webInk: store.document.webInk,
                viewport: BoardViewport(x: Double(store.viewportCenter.x), y: Double(store.viewportCenter.y), zoom: Double(store.zoom)))
        }
    }

    private func closeInlineReplay() {
        guard inlineReplay != nil else { return }
        inlineReplay = nil
        if !store.usesPhoneInterface && !replayPreviouslyReading {
            store.beginPadEditing()
            if !store.isPadReading { store.mode = replayPreviousMode }
        }
    }

    private func openChatGPT() {
        browserSidebarVisible = false
        if store.usesPhoneInterface {
            aiPresentation = .webpage
        } else { aiSidebarVisible.toggle() }
    }

    private var canEditBoardContents: Bool {
        mergePlacement == nil && !mergeOpening && inlineReplay == nil && store.canEditBoardContents && store.vaultURL != nil && !store.isBusy && !store.isPadReading && !store.reviewModeEnabled
            && !store.externalInteractionActive && !temporaryCapture.isSelecting && !translation.capture.isSelecting
    }

    private func openBrowser(url: URL? = nil) {
        if let url { browserSession.selectedTab?.open(url) }
        aiSidebarVisible = false
        if store.usesPhoneInterface || horizontalSizeClass == .compact { sheet = .browser }
        else { browserSidebarVisible = url != nil ? true : !browserSidebarVisible }
    }

    private func openOfficeWebLink(_ url: URL) {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil else { return }
        browserSession.selectedTab?.open(url)
        aiSidebarVisible = false
        if store.usesPhoneInterface || horizontalSizeClass == .compact {
            nextSheet = .browser
        } else {
            browserSidebarVisible = true
        }
        sheet = nil
    }

    private func browserPanel(fullScreen: Bool) -> some View {
        EmbeddedBrowserPanel(session: browserSession, canClip: canEditBoardContents, fullScreen: fullScreen,
            onClip: { url, title, selection in
                guard canEditBoardContents else { return false }
                if selection == nil {
                    guard let item = BoardWebCardContent.makeItem(url: url, title: title,
                        center: store.insertionPoint ?? store.viewportCenter,
                        canvasSize: CGSize(width: store.document.canvasWidth, height: store.document.canvasHeight)) else { return false }
                    store.addItem(item); store.selectedIDs = [item.id]; store.insertionPoint = nil
                    Task { _ = await store.save() }
                    return true
                }
                let point = store.insertionPoint ?? CGPoint(x: max(0, store.viewportCenter.x - 200), y: max(0, store.viewportCenter.y - 130))
                let body = selection.map { $0 + "\n\n" + String(localized: "来源：") + url.absoluteString } ?? url.absoluteString
                let item = BoardItem(kind: .text, x: min(max(0, Double(point.x)), store.document.canvasWidth - 400),
                    y: min(max(0, Double(point.y)), store.document.canvasHeight - 260), width: 400, height: 260,
                    title: title, text: body, url: url.absoluteString)
                store.addItem(item); store.selectedIDs = [item.id]; store.insertionPoint = nil
                Task { _ = await store.save() }
                return true
            }, onFullScreen: { browserSidebarVisible = false; sheet = .browser },
            onClose: { if fullScreen { sheet = nil } else { browserSidebarVisible = false } })
    }

    private func beginChatCapture(fromFullScreen: Bool) {
        guard canCaptureForChat else { return }
        returnToFullScreenAfterCapture = fromFullScreen
        if fromFullScreen { captureAfterAIDismiss = true; aiPresentation = nil }
        else { temporaryCapture.begin(sessionID: store.canvasSessionID) }
    }

    private func finishChatCapture() {
        if returnToFullScreenAfterCapture {
            returnToFullScreenAfterCapture = false; aiPresentation = .webpage
        }
    }

    private func aiDidDismiss() {
        if let next = nextAIPresentation { nextAIPresentation = nil; aiPresentation = next; return }
        if captureAfterAIDismiss {
            captureAfterAIDismiss = false
            if canCaptureForChat { temporaryCapture.begin(sessionID: store.canvasSessionID) }
            else { returnToFullScreenAfterCapture = false }
            return
        }
        if returnToSidebarAfterAI {
            returnToSidebarAfterAI = false
            if !store.usesPhoneInterface { aiSidebarVisible = true }
        }
        processHomeRequest()
    }

    private func updateAIRefreshPause() {
        store.externalRefreshPaused = sheet != nil || aiPresentation != nil || temporaryCapture.isSelecting || translation.capture.isSelecting || translation.showsSettings
    }

    private var welcome: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Image(systemName: "pencil.and.scribble")
                    .font(.largeTitle.weight(.light)).foregroundStyle(PadDesign.accent)
                Text(String(localized: "给笔记更多空间。"))
                    .font(.largeTitle.weight(.semibold)).foregroundStyle(PadDesign.ink)
                Text(store.usesPhoneInterface ? String(localized: "在手机上阅读资料、标记重点、添加独立批注与扫描文件。") : String(localized: "用 Apple Pencil 写下想法，把书页铺开，再把笔迹连成思维导图。"))
                    .font(.title3).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 14) {
                    Label(store.usesPhoneInterface ? String(localized: "默认阅读，原笔迹保留；批注独立保存") : String(localized: "原生 PencilKit 画布与 Apple Pencil Pro 工具盘"), systemImage: "pencil.tip")
                    Label(String(localized: "容量目标：至少 2,000 页资料，以页面引用和按需预览呈现"), systemImage: "rectangle.stack")
                    Label(String(localized: "直接引用资料文件夹中的原文件"), systemImage: "folder")
                }
                .font(.body)
                Button { pendingCatalogReconnect = nil; sheet = .folder } label: {
                    Label(String(localized: "选择资料文件夹"), systemImage: "folder.badge.plus")
                        .font(.headline).padding(.vertical, 8).padding(.horizontal, 8)
                }
                .buttonStyle(.borderedProminent).tint(PadDesign.accent).foregroundStyle(PadDesign.paper)
                Text(String(localized: "在系统“文件”窗口选择 iCloud 或本机的资料根文件夹。根文件夹内的文件直接引用；外部文件添加到 Attachments/InkSpace。新建白板时可选择课程目录；在 Mac 选择同一个资料根文件夹，即可读取同一套资料。"))
                    .font(.footnote).foregroundStyle(.secondary)
                if !store.usesPhoneInterface {
                    Text(String(localized: "2,000 页的实际流畅度、Pencil Pro 手势与 iCloud 文件访问仍需在你的 iPad 上验收。"))
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Text(store.status).font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: 640, alignment: .leading)
            .padding(store.usesPhoneInterface ? 22 : 40)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(PadDesign.paper)
    }

    @ToolbarContentBuilder
    private var workspaceToolbar: some ToolbarContent {
        if store.usesPhoneInterface { phoneWorkspaceToolbar }
        else { padWorkspaceToolbar }
    }

    @ToolbarContentBuilder
    private var phoneWorkspaceToolbar: some ToolbarContent {
        if !store.childNavigationHistory.isEmpty {
            ToolbarItem(placement: .topBarLeading) {
                Button(String(localized: "返回父白板"), systemImage: "chevron.backward") { Task { await store.returnToParentBoard() } }
                    .accessibilityIdentifier("children.backToParent").disabled(store.isBusy)
            }
        }
        ToolbarItem(placement: .topBarLeading) {
            Button { Task { if await store.save() { showKnowledgeHome() } } } label: {
                Image(systemName: "house").frame(width: 44, height: 44)
            }.accessibilityLabel(String(localized: "阅读空间")).accessibilityIdentifier("board.home")
                .disabled(store.isBusy || store.isSaving || store.externalInteractionActive || store.reviewModeEnabled)
        }
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button(String(localized: "白板资料库"), systemImage: "books.vertical") { sheet = .boards }
                    .accessibilityIdentifier("board.library.menu")
                Button(String(localized: "选择文字"), systemImage: "text.cursor") { store.requestReadingTextSelection() }
                    .disabled(store.boardURL == nil).accessibilityIdentifier("reading.selectText")
                Button(String(localized: "复制所选文字"), systemImage: "doc.on.doc") { store.copyReadingTextSelection() }
                    .disabled(store.boardURL == nil).accessibilityIdentifier("reading.copySelectedText")
                Button(String(localized: "浏览资料"), systemImage: "folder") { sheet = .sidebar }
                    .disabled(store.vaultURL == nil).accessibilityIdentifier("phone.browseFiles")
                Button(String(localized: "导出"), systemImage: "square.and.arrow.up") { showExport() }
                    .disabled(store.boardURL == nil || !sidebarCanOpen || store.isSaving)
                    .accessibilityIdentifier("board.export")
                Button(String(localized: "学习与复习"), systemImage: "rectangle.stack") { sheet = .study }
                    .disabled(store.boardURL == nil || !sidebarCanOpen).accessibilityIdentifier("board.study")
                Button(String(localized: "笔迹回放"), systemImage: "play.rectangle") { showInkReplay() }
                    .disabled(store.boardURL == nil || !sidebarCanOpen).accessibilityIdentifier("board.inkReplay")
                Button(String(localized: "本机文字识别"), systemImage: "text.viewfinder") { sheet = .ocrPicker }
                    .disabled(store.vaultURL == nil).accessibilityIdentifier("board.ocr")
                Button(String(localized: "AI 助手"), systemImage: "sparkles") { openChatGPT() }
                    .accessibilityIdentifier("board.assistant")
                    .disabled(store.externalInteractionActive)
                Button(String(localized: "查看与删除批注"), systemImage: "list.bullet") { sheet = .reviews }
                    .disabled(store.boardURL == nil).accessibilityIdentifier("phone.reviews.menu")
                Divider()
                Button(String(localized: "课程清单"), systemImage: "checklist") { sheet = .checklist(directory: currentBoardDirectory, filePath: nil) }
                    .disabled(store.vaultURL == nil).accessibilityIdentifier("board.checklist")
                Button(String(localized: "科学计算器"), systemImage: "plus.forwardslash.minus") { calculatorVisible.toggle() }
                    .accessibilityIdentifier("board.mathWorkspace")
                Divider()
                Button(String(localized: "选择仓库文件夹"), systemImage: "externaldrive") { pendingCatalogReconnect = nil; sheet = .folder }
                Button(String(localized: "设置"), systemImage: "gearshape") { sheet = .settings }
                    .accessibilityIdentifier("board.settings")
                Button(String(localized: "问题记录"), systemImage: "exclamationmark.bubble") { sheet = .diagnostics }
                    .accessibilityIdentifier("board.diagnostics")
            } label: { Image(systemName: "ellipsis.circle").frame(width: 44, height: 44) }
            .accessibilityLabel(String(localized: "阅读选项")).accessibilityIdentifier("board.menu")
            .disabled(store.reviewModeEnabled || store.isBusy)
        }
        if store.vaultURL != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Task { await store.refreshBoardManually() } } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }.disabled(store.isRefreshingBoard || store.isBusy || store.externalInteractionActive || store.reviewModeEnabled)
                    .accessibilityLabel(String(localized: "刷新白板")).accessibilityIdentifier("board.refresh")
            }
        }
    }

    @ToolbarContentBuilder
    private var padWorkspaceToolbar: some ToolbarContent {
        if !store.usesPhoneInterface, store.vaultURL != nil {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    let layout = PadWorkspacePanelLayout(width: workspaceWidth, wantsMaterials: true, wantsTool: hasSideTool)
                    if horizontalSizeClass == .compact || !layout.showsMaterials { sheet = .sidebar }
                    else { sidebarVisible.toggle() }
                } label: { Label(String(localized: "资料侧栏"), systemImage: "sidebar.left").frame(minWidth: 44, minHeight: 44) }
                    .accessibilityIdentifier("padSidebar.toggle")
                    .disabled(store.isBusy || store.externalInteractionActive)
            }
        }
        if !store.childNavigationHistory.isEmpty {
            ToolbarItem(placement: .topBarLeading) {
                Button(String(localized: "返回父白板"), systemImage: "chevron.backward") { Task { await store.returnToParentBoard() } }
                    .accessibilityIdentifier("children.backToParent").disabled(store.isBusy)
            }
        }
        ToolbarItem(placement: .topBarLeading) {
            Button {
                guard store.vaultURL != nil else { showKnowledgeHome(); return }
                Task { if await store.save() { showKnowledgeHome() } }
            } label: { Image(systemName: "house").frame(minWidth: 44, minHeight: 44) }
            .accessibilityLabel(String(localized: "工作台"))
            .accessibilityIdentifier("board.home")
            .disabled(store.isBusy || store.isSaving || store.externalInteractionActive || store.reviewModeEnabled)
        }
        if workspaceWindows.available {
            ToolbarItem(placement: .topBarLeading) {
                Button(action: workspaceWindows.newFolder) {
                    Label(String(localized: "新窗口"), systemImage: "plus.rectangle.on.folder").labelStyle(.titleAndIcon).frame(minHeight: 44)
                }.accessibilityLabel(String(localized: "新窗口打开文件夹"))
                    .accessibilityIdentifier("workspace.newWindow")
            }
        }
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                if store.usesPhoneInterface {
                Button(String(localized: "工作台"), systemImage: "house") {
                    guard store.vaultURL != nil else { showKnowledgeHome(); return }
                    Task {
                        if await store.save() { showKnowledgeHome() }
                    }
                }
                .disabled(store.isBusy || store.isSaving || store.externalInteractionActive)
                .accessibilityIdentifier("board.knowledgeHome")
                }
                if !store.usesPhoneInterface {
                    Button(String(localized: "自定义工具栏"), systemImage: "slider.horizontal.3") { sheet = .toolbarCustomization }
                        .accessibilityIdentifier("board.toolbar.customize.menu")
                    Divider()
                }
                Button(String(localized: "计算器"), systemImage: "function") { calculatorVisible.toggle() }
                    .accessibilityIdentifier("board.mathWorkspace")
                    .disabled(store.isBusy || store.externalInteractionActive)
                Button(mediaText("视频剪辑", "Video editor"), systemImage: "film.stack") { sheet = .mediaEditor }
                    .accessibilityIdentifier("board.mediaEditor")
                    .disabled(store.vaultURL == nil || store.isBusy || store.externalInteractionActive)
                Button(String(localized: "浏览器"), systemImage: "globe") { openBrowser() }
                    .accessibilityIdentifier("board.browser")
                    .disabled(store.isBusy || store.externalInteractionActive)
                Button(String(localized: "AI 助手"), systemImage: "sparkles") { openChatGPT() }
                    .accessibilityIdentifier("board.assistant")
                    .disabled(store.isBusy || store.externalInteractionActive)
                if !store.usesPhoneInterface {
                    pendingReviewMenu
                } else {
                    Button(String(localized: "扫描文件"), systemImage: "doc.viewfinder") { sheet = .scanner }
                        .accessibilityIdentifier("board.scan")
                        .disabled(store.vaultURL == nil || store.isBusy || store.externalInteractionActive)
                }
                Button(String(localized: "粘贴到白板"), systemImage: "doc.on.clipboard") { sheet = .pasteBoard }
                    .keyboardShortcut("v", modifiers: .command)
                    .accessibilityIdentifier("board.paste")
                    .disabled(!canEditBoardContents || sheet != nil || aiPresentation != nil)
                Divider()
                if store.vaultURL != nil && store.usesPhoneInterface {
                    Button(String(localized: "定位资料"), systemImage: "doc.text.magnifyingglass") { sheet = .readingContents }
                        .accessibilityIdentifier("board.locateFiles.menu")
                        .disabled(store.isBusy || store.externalInteractionActive)
                    Button(String(localized: "最后一笔"), systemImage: "pencil.tip.crop.circle.badge.arrow.forward") { store.jumpToLastInk() }
                        .accessibilityIdentifier("board.lastInk.menu")
                        .disabled(store.isBusy || store.externalInteractionActive)
                    Divider()
                }
                Button(String(localized: "新建白板"), systemImage: "plus") { showNewBoard() }.disabled(store.vaultURL == nil || store.isPadReading)
                Button(String(localized: "白板资料库"), systemImage: "books.vertical") { sheet = .boards }
                    .accessibilityIdentifier("board.library.menu")
                Button(String(localized: "子白板"), systemImage: "rectangle.on.rectangle") { sheet = .children(nil) }
                    .disabled(store.vaultURL == nil).accessibilityIdentifier("children.menu")
                if !store.usesPhoneInterface {
                    Button(String(localized: "合并白板"), systemImage: "rectangle.on.rectangle.angled") { sheet = .mergeBoards }
                        .disabled(store.vaultURL == nil || store.boardURL == nil || store.isBusy || store.externalInteractionActive)
                        .accessibilityIdentifier("board.merge.menu")
                }
                Button(String(localized: "学习与复习"), systemImage: "rectangle.stack") { sheet = .study }
                    .disabled(store.boardURL == nil || !sidebarCanOpen).accessibilityIdentifier("board.study")
                Button(String(localized: "笔迹回放"), systemImage: "play.rectangle") { showInkReplay() }
                    .disabled(store.boardURL == nil || !sidebarCanOpen).accessibilityIdentifier("board.inkReplay")
                Button(String(localized: "本机文字识别"), systemImage: "text.viewfinder") { sheet = .ocrPicker }
                    .disabled(store.vaultURL == nil || store.isBusy || store.externalInteractionActive).accessibilityIdentifier("board.ocr")
                Button(String(localized: "管理文件"), systemImage: "folder.badge.gearshape") { sheet = .fileManagement }
                    .disabled(store.vaultURL == nil || store.isBusy || store.externalInteractionActive || store.isPadReading)
                    .accessibilityIdentifier("board.manageFiles")
                if store.vaultURL != nil {
                    Button(String(localized: "课程清单"), systemImage: "checklist") { sheet = .checklist(directory: currentBoardDirectory, filePath: nil) }
                        .disabled(store.isBusy || store.externalInteractionActive)
                        .accessibilityIdentifier("board.checklist")
                }
                if store.usesPhoneInterface, store.vaultURL != nil {
                    Button(String(localized: "按仓库文件夹选择"), systemImage: "folder") { beginAddingFiles(using: .library) }
                    Button(String(localized: "放置位置"), systemImage: "scope") { choosePlacement() }
                    Button(String(localized: "定位"), systemImage: "mappin.and.ellipse") { sheet = .pins }
                    Button(String(localized: "框成节点"), systemImage: "rectangle.dashed") { store.mode = .frame }
                    Button(String(localized: "打印"), systemImage: "doc.text") { store.mode = .paper }
                    Button(String(localized: "截图"), systemImage: "camera") { store.command = CanvasCommand(action: .capture) }
                }
                Divider()
                Button {
                    sheet = .diagnostics
                } label: {
                    Label(DiagnosticsCenter.shared.unreadCount > 0
                        ? String(localized: "问题记录（\(DiagnosticsCenter.shared.unreadCount)）")
                        : String(localized: "问题记录"), systemImage: "exclamationmark.bubble")
                }
                .accessibilityIdentifier("board.diagnostics")
                Button(String(localized: "白板设置与本地备份"), systemImage: "externaldrive.badge.timemachine") { sheet = .backups }
                    .disabled(store.vaultURL == nil)
                    .accessibilityIdentifier("board.backupSettings")
                Button(String(localized: "结束并备份"), systemImage: "checkmark.shield") {
                    importProgress = String(localized: "正在保存白板并核对本机备份…")
                    Task { await store.endSessionAndBackup() }
                }.disabled(store.vaultURL == nil || store.isSaving)
                    .accessibilityIdentifier("board.finishAndBackup")
                Button(String(localized: "打印页面"), systemImage: "doc.text") { sheet = .printPages }.disabled(store.vaultURL == nil || store.isPadReading)
                Button(String(localized: "笔记交换"), systemImage: "arrow.left.arrow.right") { sheet = .noteExchange }
                    .disabled(store.vaultURL == nil).accessibilityIdentifier("board.exchange")
                Button(String(localized: "导出"), systemImage: "square.and.arrow.up") { showExport() }.disabled(store.vaultURL == nil)
                    .accessibilityIdentifier("board.export")
                Divider()
                Button(String(localized: "刷新白板"), systemImage: "arrow.clockwise") { Task { await store.refreshBoardManually() } }
                    .disabled(store.vaultURL == nil || store.isRefreshingBoard)
                    .accessibilityIdentifier("board.refresh.menu")
                if !store.usesPhoneInterface {
                Button(String(localized: "在 Obsidian 查看"), systemImage: "arrow.up.forward.app") {
                    Task {
                        if await store.save(forceExports: true), let url = store.obsidianLink() { openURL(url) }
                    }
                }.disabled(store.vaultURL == nil || store.isSaving)
                }
                Button(String(localized: "选择仓库文件夹"), systemImage: "externaldrive") { pendingCatalogReconnect = nil; sheet = .folder }
            } label: { Label(String(localized: "白板"), systemImage: "ellipsis.circle").frame(minWidth: 44, minHeight: 44) }
            .overlay(alignment: .topTrailing) {
                if DiagnosticsCenter.shared.unreadCount > 0 || DiagnosticsCenter.shared.storageIssue != nil {
                    Circle().fill(.orange).frame(width: 8, height: 8).allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityLabel(String(localized: "白板")).accessibilityIdentifier("board.menu")
            .disabled(store.reviewModeEnabled)
        }
        if store.vaultURL != nil {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if store.usesPhoneInterface {
                    Button { Task { await store.refreshBoardManually() } } label: {
                        if store.isRefreshingBoard { ProgressView() }
                        else { Label(String(localized: "刷新"), systemImage: "arrow.clockwise").frame(minWidth: 44, minHeight: 44) }
                    }.disabled(store.isRefreshingBoard || store.isBusy || store.isSaving || store.externalInteractionActive)
                        .accessibilityLabel(String(localized: "刷新白板"))
                        .accessibilityIdentifier("board.refresh")
                } else if !store.reviewModeEnabled && !store.isPadReading {
                    Menu {
                        Section(String(localized: "资料")) {
                            Button(String(localized: "添加文件"), systemImage: "doc.badge.plus") {
                                filePickerDirectory = currentBoardDirectoryURL
                                pendingLibraryDocuments = []
                                beginAddingFiles(using: .files(.add))
                            }.accessibilityIdentifier("board.addFiles")
                            Button(String(localized: "按仓库文件夹选择"), systemImage: "folder") { beginAddingFiles(using: .library) }
                                .accessibilityIdentifier("board.addFromVault")
                            Button(String(localized: "扫描文件"), systemImage: "doc.viewfinder") { sheet = .scanner }
                                .accessibilityIdentifier("board.scan")
                        }
                        Section(String(localized: "创作")) {
                            Button(String(localized: "文字与链接"), systemImage: "textformat") { sheet = .text }
                            Button(String(localized: "LaTeX 公式"), systemImage: "function") { sheet = .formula }
                            Button(String(localized: "子白板"), systemImage: "rectangle.on.rectangle") { sheet = .children(nil) }
                        }
                        Button(String(localized: "先选放置位置"), systemImage: "scope") { choosePlacement() }
                    } label: {
                        Label(String(localized: "添加"), systemImage: "plus").frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityIdentifier("board.addMenu")
                    .disabled(!canEditBoardContents)
                }
                Button { Task { _ = await store.save(forceExports: !store.isPadReading) } } label: {
                    Label(store.isSaving ? String(localized: "保存中") : String(localized: "保存"), systemImage: store.isDirty ? "square.and.arrow.down" : "checkmark.circle")
                        .frame(minHeight: 44)
                }.disabled(store.isSaving)
                    .accessibilityLabel(store.isSaving ? String(localized: "保存中") : String(localized: "保存"))
                    .accessibilityIdentifier("board.save")
            }
        }
    }

    private var modeHint: some View {
        Group {
            if store.mode == .paper {
                switch store.printTool {
                case .select: Label(String(localized: "轻点选择纸框，拖动移动；双指缩放白板"), systemImage: "doc.viewfinder")
                case .place: Label(String(localized: "轻点放置一张 Letter 纸的左上角"), systemImage: "doc.badge.plus")
                case .region: Label(String(localized: "框住要打印的内容，松开后选择分页方式"), systemImage: "rectangle.dashed")
                case .exportRegion: Label(String(localized: "框住要导出的区域，松开后选择 PDF 或图片"), systemImage: "square.and.arrow.up")
                }
            } else if store.mode == .place {
                Label(String(localized: "在白板点一下，选定文件左上角的位置"), systemImage: "scope")
            } else if store.mode == .frame {
                Label(String(localized: "框住完整笔迹，松开后成为导图节点"), systemImage: "rectangle.dashed")
            } else if store.mode == .arrange {
                Label(String(localized: "轻点多选，拖动节点；双击文字编辑；空白处拖动白板"), systemImage: "hand.draw")
            }
        }
        .font(.callout).fixedSize(horizontal: false, vertical: true).padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(14).allowsHitTesting(false)
    }

    private var boardNavigationButtons: some View {
        Group {
            if toolbarVisibility.isVisible(.locateFiles) {
                Button(String(localized: "定位资料"), systemImage: "doc.text.magnifyingglass") { sheet = .readingContents }
                    .accessibilityIdentifier("board.locateFiles").frame(minHeight: 44)
            }
            if toolbarVisibility.isVisible(.lastInk) {
                Button(String(localized: "最后一笔"), systemImage: "pencil.tip.crop.circle.badge.arrow.forward") { store.jumpToLastInk() }
                    .accessibilityIdentifier("board.lastInk").frame(minHeight: 44)
                    .accessibilityHint(store.canJumpToLastInk ? String(localized: "回到最后书写的位置") : String(localized: "当前没有可定位的笔迹"))
            }
        }.disabled(store.isBusy || store.externalInteractionActive)
    }

    private enum PadInteraction: String, CaseIterable {
        case reading, writing, organizing, replay
        var title: String {
            switch self {
            case .reading: String(localized: "阅读")
            case .writing: String(localized: "书写")
            case .organizing: String(localized: "整理")
            case .replay: mediaText("回放", "Replay")
            }
        }
        var symbol: String {
            switch self {
            case .reading: "book"
            case .writing: "pencil.tip"
            case .organizing: "hand.draw"
            case .replay: "clock.arrow.circlepath"
            }
        }
    }

    private var padInteraction: PadInteraction {
        inlineReplay != nil ? .replay : store.isPadReading ? .reading : store.mode == .ink ? .writing : .organizing
    }

    private func selectPadInteraction(_ interaction: PadInteraction) {
        guard !store.isBusy, !store.externalInteractionActive, !store.reviewModeEnabled,
              !temporaryCapture.isSelecting, !translation.capture.isSelecting else { return }
        if interaction == .replay { showInkReplay(); return }
        inlineReplay = nil
        if interaction == .reading {
            Task {
                if await store.beginPadReading() {
                    pendingPlacementSheet = nil
                    pendingSidebarDocuments = []
                }
            }
        } else {
            if store.isPadReading { store.beginPadEditing() }
            guard !store.isPadReading else { return }
            pendingPlacementSheet = nil
            pendingSidebarDocuments = []
            store.insertionPoint = nil
            store.mode = interaction == .writing ? .ink : .arrange
        }
    }

    private var padModeControls: some View {
        HStack(spacing: 4) {
            ForEach(PadInteraction.allCases, id: \.self) { interaction in
                Button { selectPadInteraction(interaction) } label: {
                    Label(interaction.title, systemImage: interaction.symbol)
                        .font(.callout.weight(padInteraction == interaction ? .semibold : .regular))
                        .frame(minWidth: 72, minHeight: 44)
                        .padding(.horizontal, 8)
                        .foregroundStyle(padInteraction == interaction ? PadDesign.accent : PadDesign.secondaryInk)
                        .background(padInteraction == interaction ? PadDesign.accentWash : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 12))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("ipad.mode." + interaction.rawValue)
                .accessibilityAddTraits(padInteraction == interaction ? .isSelected : [])
            }
        }
        .padding(3)
        .background(PadDesign.paper, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
        .disabled(store.isBusy || store.externalInteractionActive || temporaryCapture.isSelecting || translation.capture.isSelecting)
    }

    private var canvasViewMenu: some View {
        Menu {
            Button(String(localized: "总览"), systemImage: "arrow.up.left.and.arrow.down.right") { store.command = CanvasCommand(action: .fitAll) }
            Button(String(localized: "定位"), systemImage: "mappin.and.ellipse") { sheet = .pins }
            Divider()
            Button(String(localized: "放大"), systemImage: "plus.magnifyingglass") { store.command = CanvasCommand(action: .zoomIn) }
            Button(String(localized: "缩小"), systemImage: "minus.magnifyingglass") { store.command = CanvasCommand(action: .zoomOut) }
            Button(String(localized: "截图"), systemImage: "camera") { store.command = CanvasCommand(action: .capture) }
        } label: {
            Label("\(Int(store.zoom * 100))%", systemImage: "viewfinder")
                .font(.callout.monospacedDigit()).frame(minWidth: 70, minHeight: 44)
        }
        .accessibilityLabel(String(localized: "缩放与定位"))
        .accessibilityIdentifier("canvas.viewOptions")
    }

    private func showReviewList() {
        if store.usesPhoneInterface { sheet = .reviews; return }
        sidePanel = .reviews
        let session = store.canvasSessionID
        Task {
            await store.attachReviews()
            guard session == store.canvasSessionID, !Task.isCancelled else { return }
            await store.reviews.reload()
        }
    }

    private func beginPadReview() {
        let session = store.canvasSessionID
        Task {
            await store.beginTemporaryReview()
            if store.canvasSessionID == session, store.reviewModeEnabled {
                store.reviews.selectStyle(.comment)
                store.reviews.captureEnabled = true
            }
        }
    }

    private var pendingReviewMenu: some View {
        Button {
            if sidePanel == .reviews { sidePanel = nil } else { showReviewList() }
        } label: {
            Label(String(localized: "待批注"), systemImage: "text.bubble").frame(minHeight: 44)
        }
        .accessibilityValue(sidePanel == .reviews ? String(localized: "已显示") : String(localized: "已隐藏"))
        .accessibilityIdentifier("ipad.reviews.menu")
        .disabled(store.boardURL == nil || store.isBusy || store.externalInteractionActive || inlineReplay != nil)
    }

    private var assistantSidebarButton: some View {
        Button(String(localized: "AI 网页"), systemImage: "sparkles") { openChatGPT() }
            .frame(minHeight: 44).accessibilityIdentifier("ipad.ai.toggle")
            .disabled(store.isBusy || store.externalInteractionActive || inlineReplay != nil)
    }

    private var readingTools: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 16) {
                if toolbarVisibility.isVisible(.reviews) { pendingReviewMenu }
                if toolbarVisibility.isVisible(.assistant) { assistantSidebarButton }
                boardNavigationButtons
                if toolbarVisibility.isVisible(.selectText) {
                    Button(String(localized: "选择文字"), systemImage: "text.cursor") { store.requestReadingTextSelection() }
                        .frame(minHeight: 44).accessibilityIdentifier("reading.selectText")
                }
                if toolbarVisibility.isVisible(.copyText) {
                    Button(String(localized: "复制所选文字"), systemImage: "doc.on.doc") { store.copyReadingTextSelection() }
                        .frame(minHeight: 44).accessibilityIdentifier("reading.copySelectedText")
                }
                if toolbarVisibility.isVisible(.translation) && store.document.items.contains(where: { $0.kind == .pdfPage }) {
                    Button(String(localized: "圈选翻译"), systemImage: "character.bubble") {
                        guard let host = store.readingCanvas, !store.isBusy, !host.snapshotInteractionActive else { return }
                        let source = BoardPDFTranslationSource(store: store, host: host)
                        translationSource = source; translation.begin(source: source)
                    }.frame(minHeight: 44).accessibilityIdentifier("translation.begin.board")
                    Menu {
                        Button(String(localized: "翻译设置"), systemImage: "gearshape") { translation.showsSettings = true }
                            .accessibilityIdentifier("translation.settings.board")
                        Text(String(localized: "只读 · 不会写字或移动对象"))
                    } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44) }
                    .accessibilityLabel(String(localized: "阅读选项"))
                }
                if toolbarVisibility.isVisible(.viewOptions) { canvasViewMenu }
            }.font(.callout).buttonStyle(.borderless).padding(.horizontal, 16)
        }
    }

    // This explicit boundary keeps the toolbar's conditional generic tree out
    // of workspace/safeAreaInset. On iPadOS 27.2 the former monolithic type
    // overflowed the main-thread stack while Swift demangled its metadata.
    private var boardTools: AnyView {
        AnyView(PadBoardToolbars(
            isReading: store.isPadReading, mode: store.mode,
            hasSelection: !selectedItems.isEmpty || lastDeletion != nil,
            editingToolsExpanded: $editingToolsExpanded,
            toolbarVisibility: toolbarVisibility,
            onCustomizeToolbar: { sheet = .toolbarCustomization },
            modeControls: { AnyView(padModeControls) },
            readingTools: { inlineReplay == nil ? AnyView(readingTools) : AnyView(EmptyView()) },
            printTools: { AnyView(printTools) },
            selectionTools: { AnyView(selectionTools) },
            expandedTools: { AnyView(expandedBoardTools) },
            onUndo: { store.command = CanvasCommand(action: .undo) },
            onRedo: { store.command = CanvasCommand(action: .redo) },
            onCancelPlacement: cancelPadPlacement,
            status: store.status, isDirty: store.isDirty, pdfSyncStatus: store.pdfSyncStatus,
            onShowSyncDetails: { showsSyncDetails = true }))
    }

    private func cancelPadPlacement() {
        pendingPlacementSheet = nil
        pendingSidebarDocuments = []
        store.insertionPoint = nil
        store.mode = .arrange
    }

    private var expandedBoardTools: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                if toolbarVisibility.isVisible(.reviews) { pendingReviewMenu }
                if toolbarVisibility.isVisible(.assistant) { assistantSidebarButton }
                if store.mode == .ink {
                    if toolbarVisibility.isVisible(.penPalette) { canvasButton(String(localized: "笔与颜色"), "pencil.tip.crop.circle", .showPalette) }
                    if toolbarVisibility.isVisible(.ruler) { canvasButton(String(localized: "直尺"), "ruler", .toggleRuler) }
                    if toolbarVisibility.isVisible(.selectText) {
                        Button(String(localized: "选择文字"), systemImage: "text.cursor") { store.requestReadingTextSelection() }
                            .frame(minHeight: 44).accessibilityIdentifier("writing.selectText")
                            .disabled(store.isBusy || store.externalInteractionActive || store.reviewModeEnabled || inlineReplay != nil)
                    }
                    if toolbarVisibility.isVisible(.copyText) {
                        Button(String(localized: "复制所选文字"), systemImage: "doc.on.doc") { store.copyReadingTextSelection() }
                            .frame(minHeight: 44).accessibilityIdentifier("writing.copySelectedText")
                            .disabled(store.isBusy || store.externalInteractionActive || store.reviewModeEnabled || inlineReplay != nil)
                    }
                }
                if toolbarVisibility.isVisible(.boardTools) {
                Menu {
                    if store.mode == .ink {
                        Toggle(String(localized: "书写优先"), isOn: $store.writingPriorityEnabled)
                            .accessibilityIdentifier("writing.priority")
                        Text(String(localized: "开启时，书写中的文字识别按需启动；阅读时仍可直接长按文字。"))
                        Divider()
                        Button(String(localized: "编辑原生笔栏"), systemImage: "slider.horizontal.3") { presentNativePaletteEditor() }
                            .accessibilityIdentifier("nativePalette.manageFallback")
                        Divider()
                    }
                    Button(String(localized: "框成节点"), systemImage: "rectangle.dashed") { store.mode = .frame }
                    Button(String(localized: "放置位置"), systemImage: "scope") { choosePlacement() }
                        .accessibilityIdentifier("canvas.choosePlacement")
                    Button(String(localized: "打印布局"), systemImage: "doc.text") { store.mode = .paper }
                } label: {
                    Label(String(localized: "白板工具"), systemImage: "square.grid.2x2").frame(minHeight: 44)
                }
                .accessibilityIdentifier("canvas.mode")
                }
                boardNavigationButtons
                if toolbarVisibility.isVisible(.viewOptions) { canvasViewMenu }
            }.font(.callout).padding(.horizontal, 16).padding(.vertical, 4)
        }
    }

    private var printTools: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 16) {
                Button(String(localized: "放一页"), systemImage: "doc.badge.plus") { store.printTool = .place; store.selectedIDs = [] }
                    .accessibilityIdentifier("print.placePage")
                Picker(String(localized: "纸张方向"), selection: $store.printOrientation) {
                    ForEach(BoardPrintOrientation.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.menu)
                Button(String(localized: "框选分页"), systemImage: "rectangle.dashed") { store.printTool = .region; store.selectedIDs = [] }
                    .accessibilityIdentifier("print.selectRegion")
                Button(String(localized: "框选导出"), systemImage: "square.and.arrow.up") { store.printTool = .exportRegion; store.selectedIDs = [] }
                    .accessibilityIdentifier("print.selectExport")
                Button(String(localized: "页面列表（\(store.printFrames.count)）")) { sheet = .printPages }
                    .accessibilityIdentifier("print.pages")
                Button(String(localized: "导出")) { showExport() }.accessibilityIdentifier("print.exportDirect")
                if let frame = store.selectedPrintFrame {
                    Divider().frame(height: 24)
                    Text(String(localized: "第 \((store.printFrames.firstIndex { $0.id == frame.id } ?? 0) + 1) 页")).monospacedDigit()
                    Button(String(localized: "扩大范围")) { store.resizeSelectedPrintFrame(by: 1.1) }
                    Button(String(localized: "缩小范围")) { store.resizeSelectedPrintFrame(by: 1 / 1.1) }
                    if frame.normalizedClip != nil {
                        Button(String(localized: "使用整页内容")) { var full = frame; full.normalizedClip = nil; store.updatePrintFrame(full) }
                    }
                    Button(String(localized: "移除纸框"), role: .destructive) { store.removePrintFrames(ids: [frame.id]) }
                }
                if store.printTool != .select { Button(String(localized: "取消")) { store.printTool = .select } }
            }.font(.callout).modifier(WorkspaceTouchButtons(usesPhone: store.usesPhoneInterface)).frame(minHeight: 44).padding(.horizontal, 18)
        }
    }

    private func showExport(selection: CGRect? = nil, afterDismissal: Bool = false) {
        guard let root = store.vaultURL else { return }
        let route = WorkspaceSheet.exportBoard(BoardExportPresentation(snapshot: store.outputSnapshot(), rootURL: root, selection: selection))
        if afterDismissal { nextSheet = route; sheet = nil }
        else { sheet = route }
    }

    private func canvasButton(_ title: String, _ symbol: String, _ action: CanvasCommand.Action) -> some View {
        Button { store.command = CanvasCommand(action: action) } label: {
            Image(systemName: symbol).font(.title3).frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(title).help(title)
    }

    private var selectionTools: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 16) {
                Text(String(localized: "已选 \(selectedItems.count) 项")).font(.callout).foregroundStyle(.secondary)
                if store.usesPhoneInterface {
                Button(String(localized: "撤销"), systemImage: "arrow.uturn.backward") { store.command = CanvasCommand(action: .undo) }
                    .accessibilityIdentifier("selection.undo")
                Button(String(localized: "重做"), systemImage: "arrow.uturn.forward") { store.command = CanvasCommand(action: .redo) }
                    .accessibilityIdentifier("selection.redo")
                }
                Button(String(localized: "编辑"), systemImage: "square.and.pencil") { sheet = .edit }.disabled(selectedItems.count != 1)
                Button(String(localized: "子白板"), systemImage: "rectangle.on.rectangle") { sheet = .children(selectedItems.first?.id) }.disabled(selectedItems.count != 1)
                Button(String(localized: "打开链接或原文"), systemImage: "arrow.up.forward.app") { openSelected() }
                    .disabled(selectedItems.count != 1 || (selectedItems.first?.sourcePath == nil && selectedItems.first?.url == nil))
                if selectedItems.count == 1, selectedItems.first?.originalSourcePath != nil {
                    Button(String(localized: "打开批注版"), systemImage: "doc.richtext") { openSelectedAnnotationPDF() }
                }
                if selectedItems.count == 1, let rawURL = selectedItems.first?.url,
                   let url = URL(string: rawURL), EmbeddedBrowserTab.isWebURL(url) {
                    Button(String(localized: "用系统浏览器打开"), systemImage: "safari") { openURL(url) }
                }
                Button(String(localized: "展开选中文件"), systemImage: "rectangle.stack.badge.plus") {
                    let references = selectedItems.filter { $0.kind == .document && !BoardVideo.isVideo($0) }
                    let first = references.min { ($0.sourcePath ?? "").localizedStandardCompare($1.sourcePath ?? "") == .orderedAscending }
                    let origin = store.insertionPoint ?? first.map { CGPoint(x: $0.x, y: $0.y) } ?? store.viewportCenter
                    sheet = .expansion(ExpansionPresentation(boardID: store.document.id, references: references, origin: origin,
                                                           usesChosenPoint: store.insertionPoint != nil))
                }.disabled(!selectedItems.contains { $0.kind == .document && !BoardVideo.isVideo($0) })
                Button(String(localized: "为原文新建白板"), systemImage: "doc.badge.plus") {
                    showNewBoard(source: selectedItems.first?.originalSourcePath ?? selectedItems.first?.sourcePath)
                }.disabled(selectedItems.count != 1 || (selectedItems.first?.originalSourcePath ?? selectedItems.first?.sourcePath) == nil)
                Button(String(localized: "连成分支"), systemImage: "point.3.connected.trianglepath.dotted") { store.connectSelected() }
                    .disabled(selectedItems.count < 2)
                Button(String(localized: "还原为笔迹"), systemImage: "pencil.tip.crop.circle.badge.arrow.forward") { store.unpackSelectedInk() }
                    .disabled(!selectedItems.contains(where: { $0.kind == .inkGroup }))
                Button(String(localized: "删除"), systemImage: "trash", role: .destructive) { confirmsDelete = true }.disabled(selectedItems.isEmpty)
                if lastDeletion != nil {
                    Button(String(localized: "恢复上次删除"), systemImage: "arrow.uturn.backward.circle") { restoreDeletion() }
                }
                Menu {
                    Text(String(localized: "撤销/重做适用于笔迹和拖动。节点删除使用“恢复上次删除”。"))
                    Text(String(localized: "连线以所选节点中最靠左的节点为起点。"))
                } label: { Image(systemName: "info.circle").frame(width: 44, height: 44) }
            }.font(.callout).modifier(WorkspaceTouchButtons(usesPhone: store.usesPhoneInterface)).frame(minHeight: 48).padding(.horizontal, 18)
        }
    }

    @ViewBuilder
    private func sheetView(_ route: WorkspaceSheet) -> some View {
        if store.usesPhoneInterface && !route.allowedOnPhone {
            NavigationStack {
                ContentUnavailableView(String(localized: "请在 iPad 上编辑白板"), systemImage: "ipad.and.pencil",
                    description: Text(String(localized: "手机用于阅读、高亮、独立批注与扫描；原白板内容保持只读。")))
                    .toolbar { ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "关闭")) { sheet = nil }.frame(minHeight: 44)
                    } }
            }
        } else { sheetContent(route) }
    }

    @ViewBuilder
    private func sheetContent(_ route: WorkspaceSheet) -> some View {
        switch route {
        case .settings:
            AppSettingsView()
        case .toolbarCustomization:
            BoardToolbarCustomizationView(hiddenMask: $boardToolbarHiddenMask)
        case .study:
            StudyPanel(store: store, session: studySession, onLocate: { item in
                if store.locateItem(item.id) { studyReturnBoardID = store.document.id; sheet = nil }
            }, onSource: { item in
                guard let reference = item.sourceReference, reference.isValid, let url = store.library?.resolve(relativePath: reference.path), FileManager.default.fileExists(atPath: url.path) else { return false }
                studyReturnBoardID = store.document.id; pdfSourceReference = reference
                nextSheet = .source(url, page: reference.page); sheet = nil; return true
            })
        case .sidebar:
            if let root = store.vaultURL {
                sidebar(rootURL: root).presentationDetents([.large])
            }
        case .checklist(let directory, let filePath):
            if let root = store.vaultURL {
                CourseChecklistView(rootURL: root, initialDirectory: directory, initialFilePath: filePath)
            }
        case .manageFolder(let path, let selection):
            fileManagementSheet(initialPath: path, initialSelection: selection)
        case .knowledgeHome:
            PadKnowledgeHomeView(store: store, onContinue: { sheet = nil }, onRequest: { request in
                sheet = nil
                fallbackHomeRequest = request
            })
        case .mathWorkspace:
            NavigationStack {
                MathWorkbenchView()
                    .navigationTitle(String(localized: "数学工作台"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "完成")) { sheet = nil }
                    } }
            }
        case .children(let ownerID):
            ChildBoardsSheet(store: store, ownerID: ownerID)
        case .readingContents:
            BoardReadingContentsView(store: store) { item in
                pdfSourceReference = item.sourceReference
                let path = item.originalSourcePath ?? item.sourcePath
                guard let path, let url = store.library?.resolve(relativePath: path) else { return }
                if BoardVideo.isVideo(path: path), let root = store.vaultURL {
                    nextSheet = .video(BoardVideoRequest(rootURL: root, relativePath: path, title: item.title))
                } else { nextSheet = .source(url, page: path == item.sourcePath ? item.page : nil) }
                sheet = nil
            }
        case .fileManagement:
            fileManagementSheet(initialPath: currentBoardDirectory, initialSelection: [])
        case .reviews:
            ReviewListView(reviews: store.reviews, onJump: { store.jumpToReview($0) })
        case .reviewDraft(let draft):
            ReviewComposerView(reviews: store.reviews, draft: draft)
        case .folder:
            VaultFolderPicker { url in
                let reconnect = pendingCatalogReconnect
                let returnHome = returnHomeAfterVaultSelection
                returnHomeAfterVaultSelection = false
                pendingCatalogReconnect = nil
                sheet = nil
                Task {
                    do {
                        if let reconnect {
                            let opened = await store.openCatalogEntry(reconnect, reconnectingTo: url)
                            if !opened { sheet = .boards }
                        } else { try await store.attachVault(url) }
                        if returnHome { showKnowledgeHome() }
                    }
                    catch {
                        DiagnosticsCenter.shared.record(code: .vaultAccessFailed, operation: .connectVault, error: error)
                        store.status = error.localizedDescription
                    }
                }
            }
        case .newBoard(let request):
            BoardTitleSheet(store: store, initialDirectoryPath: request.directory,
                            initialTitle: request.title) { title, directory in
                let source = request.source
                Task {
                    if await store.newBoard(title: title, directoryPath: directory), let source {
                        addDocuments([vaultDocument(source)], action: .add)
                    }
                }
            }
            .id(request.id)
        case .boards:
            BoardLibraryView(catalog: store.boardCatalog, currentBoardURL: store.boardURL,
                             onOpen: { await store.openCatalogEntry($0) },
                             onReconnect: { entry in
                                 pendingCatalogReconnect = entry
                                 nextSheet = .folder
                                 sheet = nil
                             }, onChooseVault: {
                                 pendingCatalogReconnect = nil
                                 nextSheet = .folder
                                 sheet = nil
                             })
        case .mergeBoards:
            BoardMergeView(store: store) { service, preview in
                sheet = nil
                Task { await beginBoardMergePlacement(service: service, preview: preview) }
            }
        case .diagnostics:
            DiagnosticsCenterView(center: .shared)
        case .expansion(let request):
            DocumentExpansionSheet(fileCount: request.references.count, usesChosenPoint: request.usesChosenPoint) { options in
                guard request.boardID == store.document.id else {
                    store.status = String(localized: "已切换白板，请重新选择要展开的文件")
                    return
                }
                let refs = request.references
                addDocuments(refs.compactMap { $0.sourcePath.map(vaultDocument) }, action: .expand,
                             replacing: Set(refs.map(\.id)), origin: request.origin, options: options)
            }
            .id(request.id)
        case .printSetup(let request):
            if request.boardID == store.document.id {
                BoardPrintSetupView(store: store, boardID: request.boardID, region: request.region).id(request.id)
            }
        case .printPages:
            BoardPrintPagesView(store: store) { showExport(afterDismissal: true) }
        case .exportBoard(let request):
            BoardExportView(snapshot: request.snapshot, rootURL: request.rootURL, selectionRect: request.selection,
                onBackup: store.usesPhoneInterface ? nil : { nextSheet = .backups; sheet = nil }).id(request.id)
        case .backups:
            if let root = store.vaultURL {
                BoardBackupSettingsView(controller: store.backups, backgroundRefresh: store.backgroundRefresh, document: store.outputSnapshot(), vaultURL: root) { path in
                    sheet = nil
                    Task {
                        guard store.vaultURL == root else { return }
                        await store.openBoard(relativePath: path)
                    }
                }
            }
        case .mediaEditor:
            if let library = store.library { MediaEditorView(library: library, initialDirectory: currentBoardDirectory) }
        case .pasteBoard:
            BoardPasteView(store: store)
        case .browser:
            browserPanel(fullScreen: true)
        case .inkReplay(let request):
            InkReplayView(drawing: request.drawing, items: request.items, webInk: request.webInk, boardID: request.boardID, rootURL: request.rootURL, pdfOwnerIDs: request.pdfOwnerIDs)
                .presentationDetents([.large])
        case .ocrPicker:
            if let library = store.library {
                LocalOCRSourcePicker(library: library, initialDirectory: currentBoardDirectory) { url in
                    nextSheet = .ocr(url, page: 1); sheet = nil
                }
            }
        case .ocr(let url, let page):
            LocalOCRView(rootURL: store.vaultURL, sourceURL: url, page: page)
        case .exchangeShare(let request):
            ExchangeShareView(files: request.files)
        case .noteExchange:
            if let library = store.library {
                NoteExchangeView(library: library, initialDirectory: currentBoardDirectory,
                    canExportBoard: store.boardURL != nil, canAddToBoard: canEditBoardContents && store.boardURL != nil,
                    onOpen: { url in nextSheet = .source(url, page: nil); sheet = nil },
                    onAdd: { urls in
                        guard canEditBoardContents else { return }
                        sheet = nil
                        let entries = urls.compactMap { store.relativePath(for: $0).map { ManagedVaultEntry(path: $0, isDirectory: false) } }
                        beginSidebarAdd(entries)
                    }, onMindMap: { url in
                        try await store.importNoteOutline(url); sheet = nil
                    }, onExport: { showExport(afterDismissal: true) },
                    onOutline: {
                        nextSheet = .exchangeShare(ExchangeShareRequest(files: [try store.exportNoteOutline()])); sheet = nil
                    }, onChanged: { sidebarRefreshID = UUID() })
            }
        case .scanner:
                DocumentScanSheet(library: store.library, initialDirectory: currentBoardDirectory, canAddToBoard: canEditBoardContents && store.boardURL != nil) { url, addToBoard, recognize in
                    if addToBoard && canEditBoardContents && store.boardURL != nil {
                        addDocuments([], action: .add, externalURLs: [url])
                    } else {
                        store.status = String(localized: "扫描 PDF 已保存：\(store.relativePath(for: url) ?? url.lastPathComponent)")
                    }
                    sidebarRefreshID = UUID()
                    if recognize { nextSheet = .ocr(url, page: 1) }
                }
        case .editItem(let item):
            BoardItemEditor(store: store, existing: item, kind: item.kind)
        case .editPen(let pen):
            SavedPenEditor(store: store, existing: pen)
        case .duplicatePen(let pen):
            SavedPenEditor(store: store, existing: nil, copying: pen)
        case .addPen:
            SavedPenEditor(store: store, existing: nil)
        case .myPens:
            SavedPensSheet(store: store)
        case .library, .expandLibrary:
            if let library = store.library {
                let action: DocumentSelectionAction = route.id == WorkspaceSheet.expandLibrary.id ? .expand : .add
                VaultDocumentPicker(library: library, initialPath: currentBoardDirectory, action: action, onSelect: { documents in
                    sheet = nil
                    addDocuments(documents, action: action)
                }, onBrowseFiles: { relativePath, selected in
                    pendingLibraryDocuments = selected
                    filePickerDirectory = relativePath.isEmpty ? store.vaultURL
                        : store.vaultURL?.appendingPathComponent(relativePath, isDirectory: true)
                    pendingFileAction = action
                    sheet = nil
                })
            }
        case .files(let action):
            SystemDocumentPicker(directoryURL: filePickerDirectory ?? currentBoardDirectoryURL, onSelect: { urls in
                sheet = nil
                let previousSelection = pendingLibraryDocuments
                pendingLibraryDocuments = []
                addDocuments(previousSelection, action: action, externalURLs: urls)
            }, onCancel: { pendingLibraryDocuments = []; sheet = nil })
        case .text:
            BoardItemEditor(store: store, existing: nil, kind: .text)
                .onDisappear { if store.usesPhoneInterface { store.insertionPoint = nil; store.beginPhoneReading() } }
        case .formula:
            BoardItemEditor(store: store, existing: nil, kind: .formula)
        case .edit:
            if let item = selectedItems.first { BoardItemEditor(store: store, existing: item, kind: item.kind) }
        case .pins:
            BoardPinsSheet(store: store)
        case .snapshot:
            if let image = store.lastSnapshot { SnapshotShareView(image: image) }
        case .markdown(let path):
            if let library = store.library {
                MarkdownDocumentView(service: library.markdown, relativePath: path, allowsSourceEditing: !store.usesPhoneInterface) { _ in
                    store.refreshPreviews()
                    store.status = String(localized: "Markdown 原文已保存 · 已展开的批注页保留，重新添加原文可生成新版页面")
                }
            }
        case .video(let request):
            BoardVideoPlayerView(request: request)
        case .source(let url, let page):
            Group {
            if url.lastPathComponent.lowercased().hasSuffix(".inkcut.json"), let library = store.library {
                MediaEditorView(library: library, initialDirectory: (store.relativePath(for: url).map { ($0 as NSString).deletingLastPathComponent }) ?? currentBoardDirectory, initialProjectURL: url)
            } else if BoardVideo.isVideo(path: url.path), let root = store.vaultURL, let path = store.relativePath(for: url) {
                BoardVideoPlayerView(request: BoardVideoRequest(rootURL: root, relativePath: path, title: url.lastPathComponent))
            } else if DocumentLibrary.markdownExtensions.contains(url.pathExtension.lowercased()),
                      let library = store.library, let path = store.relativePath(for: url) {
                MarkdownDocumentView(service: library.markdown, relativePath: path, allowsSourceEditing: !store.usesPhoneInterface) { _ in
                    store.refreshPreviews()
                    store.status = String(localized: "Markdown 原文已保存 · 已展开的批注页保留，重新添加原文可生成新版页面")
                }
            } else if url.pathExtension.lowercased() == "pdf", store.usesPhoneInterface {
                PhonePDFReader(rootURL: store.vaultURL, sourceURL: url, page: page ?? 1,
                    sourceReference: studyReturnBoardID == store.document.id ? pdfSourceReference : nil,
                    closeTitle: studyReturnBoardID == store.document.id ? String(localized: "返回复习") : nil) { closeStudySourceIfNeeded() }
            } else if url.pathExtension.lowercased() == "pdf", !store.usesPhoneInterface {
                BoardPDFWorkspaceView(store: store, sourceURL: url, page: page ?? 1,
                    sourceReference: pdfSourceReference?.path == store.relativePath(for: url) ? pdfSourceReference : nil,
                    closeTitle: studyReturnBoardID == store.document.id ? String(localized: "返回复习") : nil,
                    onOpenBoard: { sheet = nil; pdfSourceReference = nil }, onClose: { closeStudySourceIfNeeded() })
            } else {
                NavigationStack {
                    Group {
                        if url.pathExtension.lowercased() == "pdf", page != nil {
                            PDFSourceView(url: url, page: page ?? 1)
                        } else if !store.usesPhoneInterface, DocumentLibrary.officeExtensions.contains(url.pathExtension.lowercased()), let library = store.library {
                            OfficeReadingTranslationView(library: library, sourceURL: url, onOpenWeb: openOfficeWebLink) { preview in
                                nextSheet = .source(preview, page: 1); sheet = nil
                            }
                        } else if DocumentLibrary.officeExtensions.contains(url.pathExtension.lowercased()) {
                            InlineOfficeReadingView(url: url, onOpenWeb: openOfficeWebLink).id(url)
                        } else if DocumentLibrary.imageExtensions.contains(url.pathExtension.lowercased()) {
                            InlineImageReadingView(url: url).id(url)
                        } else { VaultQuickLookPreview(url: url) }
                    }
                    .navigationTitle(url.lastPathComponent).navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button(String(localized: "关闭")) { sheet = nil } }
                        if DocumentLibrary.imageExtensions.contains(url.pathExtension.lowercased()) {
                            ToolbarItem(placement: .primaryAction) {
                                Button(String(localized: "本机文字识别"), systemImage: "text.viewfinder") { nextSheet = .ocr(url, page: 1); sheet = nil }
                                    .accessibilityIdentifier("source.ocr")
                            }
                        }
                    }
                }
            }
            }.onAppear { recordPresentedDocument(url) }
        }
    }

    private func recordPresentedDocument(_ url: URL) {
        guard let path = store.relativePath(for: url),
              (try? url.checkResourceIsReachable()) == true,
              FileManager.default.isReadableFile(atPath: url.path) else { return }
        store.recordRecentBrowse(kind: .document, relativePath: path, title: url.lastPathComponent)
    }

    private func closeStudySourceIfNeeded() {
        if studyReturnBoardID == store.document.id { nextSheet = .study; studyReturnBoardID = nil }
        sheet = nil; pdfSourceReference = nil
    }

    private var sidebarCanOpen: Bool {
        mergePlacement == nil && !mergeOpening && !store.isBusy && !store.isSaving && !store.externalInteractionActive
            && !store.reviewModeEnabled && store.reviews.draft == nil
            && !temporaryCapture.isSelecting && !translation.capture.isSelecting
    }

    private func sidebar(rootURL: URL) -> some View {
        PadVaultSidebar(rootURL: rootURL,
            currentBoardPath: store.boardURL.flatMap { store.relativePath(for: $0) },
            initialDirectory: currentBoardDirectory, refreshToken: sidebarRefreshID,
            canOpen: sidebarCanOpen, canChange: canEditBoardContents && sidebarCanOpen, readerOnly: store.usesPhoneInterface,
            onOpen: { entry in await openSidebarEntry(entry) },
            onAdd: { entries in beginSidebarAdd(entries) },
            onNewBoard: { directory in
                guard canEditBoardContents, sidebarCanOpen else { return }
                presentFromSidebar(.newBoard(NewBoardPresentation(source: nil, directory: directory, title: "")))
            }, onManage: { directory, selection in
                guard canEditBoardContents, sidebarCanOpen else { return }
                presentFromSidebar(.manageFolder(directory, selection))
            }, onChooseVault: {
                guard sidebarCanOpen else { return }
                pendingCatalogReconnect = nil
                presentFromSidebar(.folder)
            }, onClose: {
                if case .sidebar = sheet { sheet = nil }
                else { sidebarVisible = false }
            })
            .id(rootURL.standardizedFileURL.path)
    }

    private func presentFromSidebar(_ route: WorkspaceSheet) {
        if case .sidebar = sheet { nextSheet = route; sheet = nil }
        else { sheet = route }
    }

    private func openSidebarEntry(_ entry: ManagedVaultEntry) async -> Bool {
        guard sidebarCanOpen, !entry.isDirectory else { return false }
        if entry.path.lowercased().hasSuffix(".inkcheck.json") {
            presentFromSidebar(.checklist(directory: (entry.path as NSString).deletingLastPathComponent, filePath: entry.path))
            return true
        }
        if PadSidebarRoutes.isBoard(entry) {
            if store.boardURL.flatMap({ store.relativePath(for: $0) }) == entry.path {
                if case .sidebar = sheet { sheet = nil }
                store.recordRecentBrowse(kind: .board, relativePath: entry.path, title: store.document.title)
                return true
            }
            // BoardStore owns the save/read/activate transaction. A failed save
            // must leave the current drawing, file and viewport attached.
            let opened = await store.openBoard(relativePath: entry.path)
            if opened, case .sidebar = sheet { sheet = nil }
            return opened
        }
        guard let url = store.library?.resolve(relativePath: entry.path) else { return false }
        if BoardVideo.isVideo(path: entry.path), let root = store.vaultURL {
            presentFromSidebar(.video(BoardVideoRequest(rootURL: root, relativePath: entry.path, title: entry.title)))
        } else { presentFromSidebar(.source(url, page: nil)) }
        return true
    }

    private func beginSidebarAdd(_ entries: [ManagedVaultEntry]) {
        guard canEditBoardContents, sidebarCanOpen, !store.isPadReading, !entries.isEmpty,
              entries.allSatisfy(PadSidebarRoutes.canAdd) else { return }
        let documents = entries.map { vaultDocument($0.path) }
        if case .sidebar = sheet { sheet = nil }
        if let point = store.insertionPoint { addDocuments(documents, action: .add, origin: point) }
        else {
            pendingPlacementSheet = nil; pendingPhoneReviewPlacement = false
            pendingSidebarDocuments = documents
            store.mode = .place
            store.status = String(localized: "轻点白板选择位置，随后放入侧栏中选择的资料。")
        }
    }

    @ViewBuilder private func fileManagementSheet(initialPath: String, initialSelection: [String]) -> some View {
        if let root = store.vaultURL {
            let service = VaultFileManagement(rootURL: root)
            FileManagementView(service: service, initialPath: initialPath, initialSelection: initialSelection,
                onAction: { action in
                    let result = try await store.manageFiles(action, service: service)
                    sidebarRefreshID = UUID()
                    return result
                }, onNewBoard: { path in
                    nextSheet = .newBoard(NewBoardPresentation(source: nil, directory: path, title: "")); sheet = nil
                }, onOpen: { entry in
                    if entry.path.lowercased().hasSuffix(".inkcheck.json") {
                        nextSheet = .checklist(directory: (entry.path as NSString).deletingLastPathComponent, filePath: entry.path); sheet = nil
                    } else if PadSidebarRoutes.isBoard(entry) {
                        Task { if await store.openBoard(relativePath: entry.path) { sheet = nil } }
                    } else if let url = store.library?.resolve(relativePath: entry.path) {
                        if BoardVideo.isVideo(path: entry.path) {
                            nextSheet = .video(BoardVideoRequest(rootURL: root, relativePath: entry.path, title: entry.title))
                        } else { nextSheet = .source(url, page: nil) }
                        sheet = nil
                    }
                }, onChecklist: { path in
                    nextSheet = .checklist(directory: path, filePath: nil); sheet = nil
                })
        }
    }

    private func addDocuments(_ documents: [VaultDocument], action: DocumentSelectionAction,
                              externalURLs: [URL] = [], replacing: Set<UUID> = [],
                              origin: CGPoint? = nil, options: DocumentExpansionOptions = .init()) {
        guard canEditBoardContents, let library = store.library else { return }
        let boardID = store.document.id
        let sessionID = store.canvasSessionID
        let canvasSize = store.document.canvasWidth
        let point = origin ?? store.insertionPoint ?? CGPoint(x: max(0, store.viewportCenter.x - 280), y: max(0, store.viewportCenter.y - 180))
        store.isBusy = true
        importProgress = externalURLs.isEmpty ? String(localized: "正在准备所选文件…") : String(localized: "正在添加文件…")
        importTask = Task { @MainActor in
            defer { store.isBusy = false; importTask = nil }
            let publicationID = library.beginPublication()
            var accepted = false
            do {
                let prepared: [VaultDocument]
                if externalURLs.isEmpty {
                    prepared = try await library.prepareDocuments(documents, referenceOnly: action == .add, progress: { importProgress = $0 })
                } else {
                    let imported = try await library.importDocuments(from: externalURLs, progress: { importProgress = $0 })
                    prepared = try await library.prepareDocuments(documents + imported, referenceOnly: action == .add, progress: { importProgress = $0 })
                }
                try Task.checkCancellation()
                var items: [BoardItem]
                if action == .expand {
                    items = try await library.expandDocuments(prepared, at: point, options: options,
                        canvasSize: canvasSize, publicationID: publicationID, progress: { importProgress = $0 })
                } else {
                    items = try await library.makeInsertionItems(documents: prepared, at: point,
                        canvasSize: canvasSize, publicationID: publicationID)
                }
                try Task.checkCancellation()
                guard boardID == store.document.id, sessionID == store.canvasSessionID else {
                    throw CancellationError()
                }
                // Validate the complete replacement before mutating any board content.
                var candidate = store.document
                candidate.items.removeAll { replacing.contains($0.id) }
                candidate.edges.removeAll { replacing.contains($0.from) || replacing.contains($0.to) }
                candidate.items.append(contentsOf: items)
                try candidate.validate()
                store.document.items.removeAll { replacing.contains($0.id) }
                store.document.edges.removeAll { replacing.contains($0.from) || replacing.contains($0.to) }
                store.addItems(items)
                store.selectedIDs = action == .add ? Set(items.map(\.id)) : []
                store.insertionPoint = nil
                if store.usesPhoneInterface { store.beginPhoneReading() }
                else { store.mode = .arrange }
                // No suspension between validation and insertion: cancellation
                // before this point rolls back, afterwards the PDF is referenced.
                accepted = true
                await library.finishPublication(publicationID, accepted: true)
                store.status = action == .add
                    ? String(localized: "已添加 \(prepared.count) 个文件；图片可直接书写，文档卡片可选择方向和比例展开")
                    : String(localized: "已展开 \(items.count) 页 · \(options.direction.title)排列 · \(Int(options.scale * 100))% · 原文和批注保持关联")
                _ = await store.save()
                if action == .expand, !library.lastExpansionWarnings.isEmpty {
                    expansionWarnings = library.lastExpansionWarnings.prefix(12).joined(separator: "\n")
                    showsExpansionWarnings = true
                }
            } catch is CancellationError {
                await library.finishPublication(publicationID, accepted: accepted)
                if sessionID == store.canvasSessionID { store.status = String(localized: "已取消添加；已有白板内容保留") }
            } catch {
                DiagnosticsCenter.shared.record(code: action == .expand ? .documentRenderFailed : .documentImportFailed,
                                                operation: action == .expand ? .renderDocument : .importDocuments, error: error)
                await library.finishPublication(publicationID, accepted: accepted)
                if sessionID == store.canvasSessionID { store.status = error.localizedDescription }
            }
        }
    }

    private func cancelPhonePlacement() {
        pendingPlacementSheet = nil; pendingPhoneReviewPlacement = false
        store.insertionPoint = nil; store.beginPhoneReading()
    }
    private func beginPhoneHighlight() {
        guard store.boardURL != nil, !store.isBusy, !store.externalInteractionActive,
              !store.reviews.isWriting, store.reviews.draft == nil else { return }
        pendingPlacementSheet = nil; pendingPhoneReviewPlacement = false
        store.insertionPoint = nil; store.beginPhoneReading()
        Task {
            await store.beginTemporaryReview()
            guard store.reviewModeEnabled else { return }
            store.reviews.selectStyle(.highlight)
            store.reviews.captureEnabled = true
        }
    }
    private func beginPhoneReviewPlacement() {
        guard store.boardURL != nil, !store.isBusy, !store.externalInteractionActive,
              !store.reviews.isWriting, store.reviews.draft == nil else { return }
        pendingPlacementSheet = nil; pendingPhoneReviewPlacement = true
        store.reviews.selectStyle(.comment)
        store.reviewModeEnabled = false
        store.insertionPoint = nil; store.phoneMarkupEnabled = false; store.mode = .place
        store.status = String(localized: "先选批注位置；评论独立保存，不改原文和正式笔迹。")
    }

    private func choosePlacement() {
        guard canEditBoardContents else { return }
        pendingPlacementSheet = nil
        store.insertionPoint = nil
        store.mode = .place
        store.status = String(localized: "在白板点一下选定放置位置，然后添加文件或展开所选卡片")
    }

    private func beginAddingFiles(using route: WorkspaceSheet) {
        guard canEditBoardContents else { return }
        if store.insertionPoint != nil { sheet = route }
        else {
            pendingPlacementSheet = route
            store.mode = .place
            store.status = String(localized: "先在白板点一下选位置，随后选择要添加的文件")
        }
    }

    private func vaultDocument(_ path: String) -> VaultDocument {
        VaultDocument(relativePath: path, title: (path as NSString).lastPathComponent,
                      fileExtension: (path as NSString).pathExtension.lowercased(), byteCount: 0, requiresDownload: false)
    }

    private var currentBoardDirectoryURL: URL? {
        if let boardURL = store.boardURL { return boardURL.deletingLastPathComponent() }
        return store.vaultURL
    }

    private var currentBoardDirectory: String {
        store.boardURL.flatMap { store.relativePath(for: $0) }.map { ($0 as NSString).deletingLastPathComponent } ?? ""
    }

    private func showNewBoard(source: String? = nil, directory: String? = nil) {
        let location: String
        if let directory { location = directory }
        else if let source { location = (source as NSString).deletingLastPathComponent }
        else if let url = store.boardURL, let path = store.relativePath(for: url) {
            location = (path as NSString).deletingLastPathComponent
        } else { location = "InkSpace" }
        let title = source.map { (($0 as NSString).lastPathComponent as NSString).deletingPathExtension + String(localized: " · 白板") } ?? ""
        let request = WorkspaceSheet.newBoard(NewBoardPresentation(source: source, directory: location, title: title))
        if case .knowledgeHome = sheet { nextSheet = request; sheet = nil }
        else { sheet = request }
    }

    private func presentRequestedBoard() {
        guard !store.isBusy, let root = store.vaultURL,
              store.pendingNewBoardSource != nil || store.pendingNewBoardDirectory != nil else { return }
        defer {
            store.pendingNewBoardSource = nil
            store.pendingNewBoardDirectory = nil
            store.pendingNewBoardVault = nil
        }
        guard !store.usesPhoneInterface else {
            store.status = String(localized: "请在 iPad 上编辑白板")
            return
        }
        guard store.pendingNewBoardVault == root.lastPathComponent else {
            store.status = String(localized: "请先选择对应的资料根文件夹，再从课程目录新建白板")
            return
        }
        if let directory = store.pendingNewBoardDirectory {
            guard (try? BoardStorageLocations.directory(root: root, relativePath: directory)) != nil else {
                store.status = String(localized: "课程文件夹暂不可用，请检查 iCloud 下载状态")
                return
            }
            showNewBoard(directory: directory)
        } else if let source = store.pendingNewBoardSource {
            guard VaultPath.isSafeRelative(source), let url = store.library?.resolve(relativePath: source),
                  DocumentLibrary.supportedExtensions.contains(url.pathExtension.lowercased()) else {
                store.status = String(localized: "原文件暂不可用，请检查 iCloud 下载状态")
                return
            }
            showNewBoard(source: source)
        }
    }

    private func openSelected() {
        guard let item = selectedItems.first else { return }
        pdfSourceReference = item.sourceReference
        if let rawURL = item.url, let url = URL(string: rawURL),
                  ["https", "http", "obsidian", "inkspace"].contains(url.scheme?.lowercased() ?? "") {
            if EmbeddedBrowserTab.isWebURL(url) { openBrowser(url: url) }
            else { openURL(url) }
        } else if let path = item.originalSourcePath ?? item.sourcePath, let url = store.library?.resolve(relativePath: path) {
            if BoardVideo.isVideo(path: path), let root = store.vaultURL {
                sheet = .video(BoardVideoRequest(rootURL: root, relativePath: path, title: item.title))
            } else {
                sheet = .source(url, page: item.originalSourcePath == nil ? item.page : nil)
            }
        } else { store.status = String(localized: "链接无效，或原文件暂不可用") }
    }

    private func openSelectedAnnotationPDF() {
        guard let item = selectedItems.first, let path = item.sourcePath,
              let url = store.library?.resolve(relativePath: path), url.pathExtension.lowercased() == "pdf" else {
            store.status = String(localized: "批注版暂不可用，请检查 iCloud 下载状态")
            return
        }
        pdfSourceReference = item.sourceReference
        sheet = .source(url, page: item.page ?? 1)
    }

    private func deleteSelection() {
        guard canEditBoardContents else { return }
        let ids = store.selectedIDs
        lastDeletion = DeletedSelection(boardID: store.document.id, items: selectedItems,
                                         edges: store.document.edges.filter { ids.contains($0.from) || ids.contains($0.to) })
        store.deleteSelected()
    }

    private func restoreDeletion() {
        guard canEditBoardContents else { return }
        guard let deletion = lastDeletion, deletion.boardID == store.document.id else { return }
        let existingIDs = Set(store.document.items.map(\.id))
        store.document.items.append(contentsOf: deletion.items.filter { !existingIDs.contains($0.id) })
        let itemIDs = Set(store.document.items.map(\.id))
        let edgeIDs = Set(store.document.edges.map(\.id))
        store.document.edges.append(contentsOf: deletion.edges.filter {
            !edgeIDs.contains($0.id) && itemIDs.contains($0.from) && itemIDs.contains($0.to)
        })
        store.selectedIDs = Set(deletion.items.map(\.id))
        lastDeletion = nil
        store.changed()
    }
}


/// Concrete, non-generic sections deliberately bound runtime type metadata.
/// State ownership stays in InkSpaceWorkspaceView/BoardStore. Lazy erased
/// content avoids constructing hidden tool rows and preserves their identity.
private struct PadBoardToolbars: View {
    let isReading: Bool
    let mode: BoardMode
    let hasSelection: Bool
    @Binding var editingToolsExpanded: Bool
    let toolbarVisibility: BoardToolbarVisibility
    let onCustomizeToolbar: () -> Void
    let modeControls: () -> AnyView
    let readingTools: () -> AnyView
    let printTools: () -> AnyView
    let selectionTools: () -> AnyView
    let expandedTools: () -> AnyView
    let onUndo: () -> Void
    let onRedo: () -> Void
    let onCancelPlacement: () -> Void
    let status: String
    let isDirty: Bool
    let pdfSyncStatus: String
    let onShowSyncDetails: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PadBoardPrimaryToolbar(isReading: isReading,
                editingToolsExpanded: $editingToolsExpanded,
                toolbarVisibility: toolbarVisibility, onCustomizeToolbar: onCustomizeToolbar,
                modeControls: modeControls, onUndo: onUndo, onRedo: onRedo)
            if isReading {
                readingTools()
            } else {
                PadBoardEditingToolRows(mode: mode, hasSelection: hasSelection,
                    editingToolsExpanded: editingToolsExpanded, printTools: printTools,
                    selectionTools: selectionTools,
                    expandedTools: expandedTools, onCancelPlacement: onCancelPlacement)
            }
            PadBoardStatusStrip(status: status, isDirty: isDirty,
                pdfSyncStatus: pdfSyncStatus, onShowSyncDetails: onShowSyncDetails)
        }
        .background(PadDesign.surface)
        .tint(PadDesign.accent)
        .overlay(alignment: .bottom) {
            Rectangle().fill(PadDesign.hairline).frame(height: 0.7).allowsHitTesting(false)
        }
    }
}

private struct PadBoardPrimaryToolbar: View {
    let isReading: Bool
    @Binding var editingToolsExpanded: Bool
    let toolbarVisibility: BoardToolbarVisibility
    let onCustomizeToolbar: () -> Void
    let modeControls: () -> AnyView
    let onUndo: () -> Void
    let onRedo: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                modeControls()
                if !isReading {
                    Divider().frame(height: 24)
                    if toolbarVisibility.isVisible(.undo) {
                        PadBoardHistoryButton(title: String(localized: "撤销"), symbol: "arrow.uturn.backward", action: onUndo)
                    }
                    if toolbarVisibility.isVisible(.redo) {
                        PadBoardHistoryButton(title: String(localized: "重做"), symbol: "arrow.uturn.forward", action: onRedo)
                    }
                    Button { editingToolsExpanded.toggle() } label: {
                        Label(editingToolsExpanded ? String(localized: "收起工具") : String(localized: "更多工具"),
                              systemImage: editingToolsExpanded ? "chevron.up" : "slider.horizontal.3")
                            .font(.callout.weight(.medium)).frame(minWidth: 44, minHeight: 44)
                            .padding(.horizontal, 10)
                            .foregroundStyle(PadDesign.accent)
                            .background(PadDesign.accentWash, in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier("canvas.toggleTools")
                    .accessibilityValue(editingToolsExpanded ? String(localized: "已展开") : String(localized: "已收起"))
                }
                Button(action: onCustomizeToolbar) {
                    Image(systemName: "ellipsis.circle").font(.body.weight(.medium))
                        .frame(minWidth: 44, minHeight: 44).foregroundStyle(PadDesign.accent)
                        .padSurface(radius: 12)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(String(localized: "自定义工具栏"))
                .accessibilityIdentifier("board.toolbar.customize")
            }.padding(.horizontal, 12).padding(.vertical, 6)
        }
    }
}

private struct PadBoardHistoryButton: View {
    let title: String
    let symbol: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.body.weight(.medium)).frame(minWidth: 44, minHeight: 44)
                .foregroundStyle(PadDesign.accent)
                .padSurface(radius: 12)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(title).help(title)
    }
}

private struct PadBoardEditingToolRows: View {
    let mode: BoardMode
    let hasSelection: Bool
    let editingToolsExpanded: Bool
    let printTools: () -> AnyView
    let selectionTools: () -> AnyView
    let expandedTools: () -> AnyView
    let onCancelPlacement: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            if mode == .paper { printTools() }
            // Keep the writing canvas and its docked tools stationary while
            // selection actions appear/disappear between the two taps.
            if mode == .ink {
                ZStack(alignment: .leading) {
                    selectionTools().opacity(hasSelection ? 1 : 0)
                        .allowsHitTesting(hasSelection).accessibilityHidden(!hasSelection)
                    if !hasSelection {
                        Text(String(localized: "单击切换工具 · 双击工具调整设置"))
                            .font(.callout).foregroundStyle(.secondary).padding(.horizontal, 18)
                    }
                }
            } else if hasSelection { selectionTools() }
            if mode == .place { PadBoardPlacementToolbar(onCancel: onCancelPlacement) }
            if editingToolsExpanded {
                expandedTools()
            }
        }
    }
}

private struct PadBoardPlacementToolbar: View {
    let onCancel: () -> Void
    var body: some View {
        HStack {
            Label(String(localized: "点选白板上的放置位置"), systemImage: "scope").font(.callout)
            Spacer()
            Button(String(localized: "取消选位置"), action: onCancel)
                .frame(minHeight: 44).accessibilityIdentifier("canvas.cancelPlacement")
        }.padding(.horizontal, 16)
    }
}

private struct PadBoardStatusStrip: View {
    let status: String
    let isDirty: Bool
    let pdfSyncStatus: String
    let onShowSyncDetails: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(spacing: 0) {
            if !status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pdfSyncStatus.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: isDirty ? "circle.dotted" : "checkmark.circle")
                        .foregroundStyle(isDirty ? PadDesign.bronze : PadDesign.secondaryInk)
                    Text(status).lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2).frame(maxWidth: .infinity, alignment: .leading)
                    if !pdfSyncStatus.isEmpty {
                        Button(String(localized: "查看原因"), action: onShowSyncDetails)
                            .frame(minHeight: 44).fixedSize()
                    }
                }
                .font(.caption).foregroundStyle(PadDesign.secondaryInk)
                .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("board.actionStatus")
            }
        }
    }
}

private struct WorkspaceTouchButtons: ViewModifier {
    let usesPhone: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if usesPhone { content.buttonStyle(.borderless) }
        else { content.buttonStyle(PadWorkspaceTouchButtonStyle()) }
    }
}

private struct PadWorkspaceTouchButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .foregroundStyle(!isEnabled ? Color.secondary : configuration.role == .destructive ? Color.red : Color.accentColor)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
