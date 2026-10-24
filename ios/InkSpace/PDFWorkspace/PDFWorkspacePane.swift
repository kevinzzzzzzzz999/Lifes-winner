import Foundation
import Observation
import PDFKit
import UIKit
import PencilKit

enum PDFWorkspaceTool: String, CaseIterable, Identifiable {
    case read, ink, highlight, text
    var id: String { rawValue }
    var title: String { switch self {
        case .read: String(localized: "阅读")
        case .ink: String(localized: "笔迹图层")
        case .highlight: String(localized: "重点框选")
        case .text: String(localized: "文字批注")
    } }
}
private enum PDFWorkspaceHistoryAction {
    case addAnnotation(PDFWorkspaceAnnotation)
    case removeAnnotation(PDFWorkspaceAnnotation)
    case addAnnotations([PDFWorkspaceAnnotation])
    case removeAnnotations([PDFWorkspaceAnnotation])
    case addLayer(PDFWorkspaceLayer)
    case removeLayer(PDFWorkspaceLayer, [PDFWorkspaceAnnotation])
    case restoreLayer(PDFWorkspaceLayer, [PDFWorkspaceAnnotation])
    case setLayer(PDFWorkspaceLayer)
}
private struct PDFWorkspaceWritePlan {
    let events: [PDFWorkspaceEvent]
    let inverse: PDFWorkspaceHistoryAction
    let selectedLayer: UUID?
    let sourceSHA256: String
    let route: Int // 0 ordinary, 1 undo, 2 redo
}

@MainActor @Observable final class PDFWorkspacePane: Identifiable {
    enum Access { case full, readingHighlights }
    let id = UUID()
    let access: Access
    let rootURL: URL?
    let sourceURL: URL
    let repository: PDFWorkspaceRepository
    let extensionStore: PDFExtensionStore
    var imageExcerptActive=false
    var extensionMode=false
    private var loadedExtensionMode=false
    var layerReplayActive=false
    var layerReplayPlaying=false
    var layerReplayPosition=0
    var replayDisplayMode = InkReplayDisplayMode.preferred
    var pendingSourceReference:PDFSourceReference?
    var pendingExtensionBlockID:String?
    let temporaryTranslation: PDFTranslationSession
    let captureSource = PDFReaderTranslationSource()
    let readAloud = BoardReadAloudController()
    var readAloudPage = -1
    var readAloudRect: CGRect?
    func beginReadAloud(pages: ClosedRange<Int>?) {
        guard !isLoading, !isSaving, !hasPendingWrite, !interactionActive, document != nil else { return }
        chooseTool(.read); extensionMode = false
        readAloud.onPDFHighlight = { [weak self] index, rect in
            guard let self else { return }
            if index >= 0, self.readAloudPage != index, !self.interactionActive { self.navigate(to: index + 1) }
            self.readAloudPage = index; self.readAloudRect = rect
        }
        readAloud.startPDF(url: sourceURL, pages: pages, title: title)
    }
    let translationJob: PDFWorkspaceTranslationJob
    private(set) var document: PDFDocument?
    private(set) var sourceSHA256 = ""
    private(set) var projection = PDFWorkspaceProjection(layers: [], annotations: [], warnings: [])
    private(set) var records: [PDFWorkspaceEvent] = []
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var hasPendingWrite = false
    private(set) var canUndo = false
    private(set) var canRedo = false
    var error = ""
    var page = 1
    var zoom: CGFloat = 0
    var tool: PDFWorkspaceTool = .read
    var selectedLayerID: UUID?
    var color = "#C53732"
    var lineWidth = 0.003
    var inkPenSettings = (try? SavedPenSettings.load()) ?? SavedPenSettings()
    var selectedInkPen: SavedPen? { inkPenSettings.pens.first { $0.id == inkPenSettings.selectedID && SavedPenKind.supportedCases.contains($0.kind) } }
    func inkTool(width: CGFloat) -> PKInkingTool {
        guard let pen = selectedInkPen else {
            return PKInkingTool(.pen, color: PDFExtensionPaint.color(color), width: max(0.5, lineWidth * width))
        }
        return PKInkingTool(pen.kind.inkType,
            color: UIColor(red: pen.red, green: pen.green, blue: pen.blue, alpha: pen.alpha),
            width: min(pen.kind.maximumWidth, max(pen.kind.minimumWidth, pen.width)))
    }
    var interactionActive = false
    var textDraft: PDFWorkspaceAnnotation?
    var draftText = ""
    var revision = 0
    var showsLayers = false
    var showsTranslationSetup = false
    @ObservationIgnored weak var pdfView: PDFView?
    @ObservationIgnored weak var textSelectionHost: PDFWorkspaceReaderHost?
    var textSelectionStatus = ""
    var extendedTextSelectionRequest = 0
    var extendedInkTextSelectionEnabled = false
    func selectVisibleText() {
        guard document != nil, !isLoading, !isSaving, !hasPendingWrite, !interactionActive else { return }
        if extensionMode {
            extendedInkTextSelectionEnabled = true
            extendedTextSelectionRequest &+= 1
            textSelectionStatus = String(localized: "停稳后可跨当前画面中的正文与留白选字。拖动手柄调整范围；移动页面后重新选择。手写和公式请核对。")
            return
        }
        if tool != .ink { chooseTool(.read) }
        DispatchQueue.main.async { [weak self] in self?.textSelectionHost?.revealVisibleText() }
    }
    func copyVisibleText() {
        if extensionMode {
            // SwiftUI note text and Live Text share UIKit's standard Copy action.
            let before = UIPasteboard.general.changeCount
            let sent = UIApplication.shared.sendAction(#selector(UIResponderStandardEditActions.copy(_:)), to: nil, from: nil, for: nil)
            let copied = sent && UIPasteboard.general.changeCount != before
            textSelectionStatus = copied ? String(localized: "已复制所选文字。") : String(localized: "请先长按页面文字并调整选区。")
            return
        }
        if textSelectionHost?.hasActiveTextSelection == true {
            textSelectionHost?.copyVisibleText(); return
        }
        guard let text = pdfView?.currentSelection?.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            textSelectionHost?.copyVisibleText(); return
        }
        UIPasteboard.general.string = text
        textSelectionStatus = String(localized: "已复制所选文字。")
    }
    @ObservationIgnored private var undoStack: [PDFWorkspaceHistoryAction] = []
    @ObservationIgnored private var redoStack: [PDFWorkspaceHistoryAction] = []
    @ObservationIgnored private var pending: PDFWorkspaceWritePlan?
    @ObservationIgnored private var reloadID: UUID?
    @ObservationIgnored var needsRefresh = false
    @ObservationIgnored private var readerSuspended = false

    init(rootURL: URL?, sourceURL: URL, page: Int = 1, access: Access = .full, client: PDFTranslationClient = PDFTranslationClient(), readKey: @escaping (PDFTranslationProvider) throws -> String = { try PDFTranslationKeyStore.read($0) }) {
        self.access = access
        self.rootURL = rootURL; self.sourceURL = sourceURL; self.page = max(1,page)
        repository = PDFWorkspaceRepository(rootURL: rootURL, sourceURL: sourceURL)
        extensionStore = PDFExtensionStore(rootURL:rootURL,sourceURL:sourceURL)
        temporaryTranslation = PDFTranslationSession(client: client, readKey: readKey)
        translationJob = PDFWorkspaceTranslationJob(client: client, readKey: readKey)
    }
    var title: String { sourceURL.lastPathComponent }
    var pageCount: Int { document?.pageCount ?? 0 }
    var selectedLayer: PDFWorkspaceLayer? { projection.layers.first { $0.id == selectedLayerID } }
    var canAnnotate: Bool {
        !imageExcerptActive && !layerReplayActive && rootURL != nil && !isLoading && !isSaving && !hasPendingWrite && document != nil && !sourceSHA256.isEmpty && selectedLayer?.visible == true && selectedLayer?.locked == false
    }
    var mismatchedVersionCount: Int { projection.annotations.filter { $0.sourceSHA256 != sourceSHA256 }.count }
    var displayedAnnotations: [PDFWorkspaceAnnotation] {
        let visible = Set(projection.layers.filter(\.visible).map(\.id))
        let permitted=layerReplayActive && replayDisplayMode == .progressive ? Set(replayMarks.prefix(layerReplayPosition).map(\.id)):nil
        return projection.annotations.filter { $0.sourceSHA256 == sourceSHA256 && visible.contains($0.layerID) && ($0.kind != .ink || permitted == nil || permitted!.contains($0.id)) }
    }
    var futureReplayIDs: Set<UUID> {
        layerReplayActive && replayDisplayMode == .dimmed ? Set(replayMarks.dropFirst(layerReplayPosition).map(\.id)) : []
    }
    func setReplayDisplayMode(_ value: InkReplayDisplayMode) {
        replayDisplayMode = value; UserDefaults.standard.set(value.rawValue, forKey: InkReplayDisplayMode.preferenceKey); revision += 1
    }
    var replayMarks:[PDFWorkspaceAnnotation] {
        let visible=Set(projection.layers.filter(\.visible).map(\.id))
        let current=Dictionary(projection.annotations.filter{$0.kind == .ink && $0.sourceSHA256==sourceSHA256 && visible.contains($0.layerID)}.map{($0.id,$0)},uniquingKeysWith:{a,_ in a})
        var found=Set<UUID>()
        return records.sorted{$0.createdAt == $1.createdAt ? $0.id.uuidString<$1.id.uuidString:$0.createdAt<$1.createdAt}.compactMap{ event in
            guard let mark=event.annotation,let live=current[mark.id],found.insert(mark.id).inserted else{return nil};return live
        }
    }
    func toggleLayerReplay() {
        guard !interactionActive,!isSaving,!hasPendingWrite else{return}
        layerReplayActive.toggle();layerReplayPlaying=false;tool = .read
        layerReplayPosition=replayMarks.count;revision+=1
    }
    func setLayerReplayPosition(_ position:Int) {
        layerReplayPosition=min(replayMarks.count,max(0,position));revision+=1
        if layerReplayPosition>0 {navigate(to:replayMarks[layerReplayPosition-1].page)}
    }
    func refresh() async {
        guard !readerSuspended else { return }
        guard !isLoading, !isSaving, !hasPendingWrite, !interactionActive, !imageExcerptActive, textDraft == nil else { needsRefresh = true; return }
        isLoading = true; let token = UUID(); reloadID = token
        defer { if reloadID == token { isLoading = false } }
        do {
            let snapshot = try await repository.load()
            let bytes = (document == nil || sourceSHA256 != snapshot.sourceSHA256) ? try await repository.readPDF(expectedSHA256: snapshot.sourceSHA256) : nil
            try Task.checkCancellation()
            guard reloadID == token, !readerSuspended else { return }
            guard !interactionActive, !imageExcerptActive, !hasPendingWrite, !isSaving, textDraft == nil else { needsRefresh = true; return }
            if let bytes {
                guard let pdf = PDFDocument(data: bytes), !pdf.isLocked, pdf.pageCount > 0 else { throw PDFWorkspaceError.readUnavailable }
                document = pdf; page = min(max(1,page), pdf.pageCount)
                temporaryTranslation.close(); translationJob.cancel()
            }
            sourceSHA256 = snapshot.sourceSHA256; apply(snapshot)
            needsRefresh = false; error = ""
            await extensionStore.refresh()
            try Task.checkCancellation()
            guard reloadID == token, !readerSuspended else { return }
            if !loadedExtensionMode { extensionMode = !extensionStore.blocks.isEmpty;loadedExtensionMode=true }
        } catch is CancellationError {
            guard reloadID == token, !readerSuspended else { return }
            needsRefresh = true
        } catch {
            guard reloadID == token, !readerSuspended else { return }
            self.error = PDFWorkspaceError.readingErrorDescription(error); needsRefresh = true
        }
    }
    /// Cancels only the reader's claim on a refresh, never a pending publication.
    /// Task ownership lives in the reader; late I/O results are rejected by token.
    func cancelRefresh() { reloadID = nil; isLoading = false; needsRefresh = true }
    private func apply(_ snapshot: PDFWorkspaceSnapshot) {
        records = snapshot.records; projection = snapshot.projection; revision += 1
        if let selectedLayerID, !projection.layers.contains(where: { $0.id == selectedLayerID }) { self.selectedLayerID = nil; tool = .read }
        if selectedLayer?.visible != true || selectedLayer?.locked != false { tool = .read }
    }
    func chooseTool(_ value: PDFWorkspaceTool) {
        guard access == .full || value == .read || value == .highlight else { error = String(localized: "手机阅读仅支持独立高亮与批注。"); return }
        guard value == .read || canAnnotate else { error = PDFWorkspaceError.lockedLayer.localizedDescription; showsLayers = true; return }
        guard !interactionActive, !imageExcerptActive else { return }; if value != .read {layerReplayActive=false;layerReplayPlaying=false}; tool = value
    }
    func navigate(to page: Int) {
        guard !interactionActive, !imageExcerptActive, let document, let target = document.page(at: min(max(1,page),document.pageCount)-1) else { return }
        self.page = document.index(for: target)+1; pdfView?.go(to: target)
    }
    func addLayer(name: String) async {
        guard access == .full else { return }
        await createLayer(name: name)
    }
    private func createLayer(name: String) async {
        let layer = PDFWorkspaceLayer(id: UUID(), name: name, visible: true, locked: false, order: min(9_007_199_254_740_991, (projection.layers.map(\.order).max() ?? -1) + 1))
        await act(.addLayer(layer))
    }
    func setLayer(_ layer: PDFWorkspaceLayer) async { guard access == .full else { return }; await act(.setLayer(layer)) }
    func deleteLayer(_ layer: PDFWorkspaceLayer) async {
        guard access == .full else { return }
        let marks = projection.annotations.filter { $0.layerID == layer.id }
        guard marks.count <= 509 else { error = String(localized: "该图层批注较多，请先隐藏图层或分批删除批注。"); return }
        await act(.removeLayer(layer,marks))
    }
    /// The phone creates only the shared reading layer, on the first explicit mark.
    /// Existing locked/hidden layers remain untouched.
    func prepareReadingLayer() async -> Bool {
        guard !isLoading, !isSaving, !hasPendingWrite, !interactionActive,
              rootURL != nil, document != nil, !sourceSHA256.isEmpty else { return false }
        if let layer = projection.layers.first(where: { $0.name == PDFReadingHighlight.layerName && $0.visible && !$0.locked }) {
            selectedLayerID = layer.id
        } else { await createLayer(name: PDFReadingHighlight.layerName) }
        return canAnnotate
    }
    @discardableResult func addAnnotation(_ annotation: PDFWorkspaceAnnotation) async -> Bool {
        guard access == .full || PDFReadingHighlight.allows(annotation.kind) else { error = String(localized: "手机阅读仅支持独立高亮与批注。"); return false }
        return await act(.addAnnotation(annotation))
    }
    @discardableResult func addReadingHighlights(_ annotations: [PDFWorkspaceAnnotation]) async -> Bool {
        guard !annotations.isEmpty, annotations.count <= PDFReadingHighlight.maximumParts,
              annotations.allSatisfy({ PDFReadingHighlight.allows($0.kind) && $0.sourceSHA256 == sourceSHA256 && $0.layerID == selectedLayerID }) else { return false }
        return await act(.addAnnotations(annotations))
    }
    func deleteAnnotation(_ annotation: PDFWorkspaceAnnotation) async {
        // Check the stored record rather than trusting the supplied kind. A
        // caller cannot disguise a Pencil mark as a highlight with the same ID.
        if access == .readingHighlights {
            guard let stored = projection.annotations.first(where: { $0.id == annotation.id }), PDFReadingHighlight.allows(stored.kind) else {
                error = String(localized: "手机阅读仅支持独立高亮与批注。"); return
            }
            await act(.removeAnnotation(stored))
        } else { await act(.removeAnnotation(annotation)) }
    }
    func undo() async { if let value = undoStack.last { await act(value, route: 1) } }
    func redo() async { if let value = redoStack.last { await act(value, route: 2) } }
    func retry() async { guard let pending, !isSaving else { return }; await publish(pending) }
    func discardPending() async {
        guard !isSaving else { return }
        pending = nil; hasPendingWrite = false; error = ""; await refresh()
    }
    @discardableResult private func act(_ action: PDFWorkspaceHistoryAction, route: Int = 0) async -> Bool {
        guard !isSaving, !isLoading, !hasPendingWrite, !interactionActive, !sourceSHA256.isEmpty else { return false }
        do { let plan = try plan(action, route: route); pending = plan; hasPendingWrite = true; return await publish(plan) }
        catch { self.error = error.localizedDescription; return false }
    }
    private func plan(_ action: PDFWorkspaceHistoryAction, route: Int) throws -> PDFWorkspaceWritePlan {
        var events: [PDFWorkspaceEvent] = [], inverse: PDFWorkspaceHistoryAction
        var selection = selectedLayerID
        switch action {
        case .addAnnotation(var mark):
            mark.id = UUID(); events = [try .make(annotation: mark)]; inverse = .removeAnnotation(mark)
        case .removeAnnotation(let mark):
            events = [try .deleteAnnotation(mark.id)]; inverse = .addAnnotation(mark)
        case .addAnnotations(let marks):
            let copies = marks.map { value in var copy = value; copy.id = UUID(); return copy }
            events = try copies.map { try .make(annotation: $0) }; inverse = .removeAnnotations(copies)
        case .removeAnnotations(let marks):
            events = try marks.map { try .deleteAnnotation($0.id) }; inverse = .addAnnotations(marks)
        case .addLayer(var layer):
            layer.id = UUID(); events = [try .make(layer: layer)]; selection = layer.id; inverse = .removeLayer(layer, [])
        case .removeLayer(let layer, let marks):
            events = [try .deleteLayer(layer.id)]; inverse = .restoreLayer(layer, marks)
        case .restoreLayer(var layer, let marks):
            layer.id = UUID(); let final = layer; layer.visible = true; layer.locked = false
            events = [try .make(layer: layer)]
            let clones = marks.map { value in var copy = value; copy.id = UUID(); copy.layerID = layer.id; return copy }
            events += try clones.map { try .make(annotation: $0) }
            if layer != final { events.append(try .make(layer: final)) }
            selection = layer.id; inverse = .removeLayer(final, clones)
        case .setLayer(let layer):
            guard let previous = projection.layers.first(where: { $0.id == layer.id }) else { throw PDFWorkspaceError.lockedLayer }
            events = [try .make(layer: layer)]; inverse = .setLayer(previous)
        }
        // LWW compares (parsed time, UUID). A batch must not depend on random
        // UUID ordering when restoring an unlocked layer then its final flags.
        var instant = max(Date().timeIntervalSince1970, records.map { $0.instant.timeIntervalSince1970 }.max() ?? 0)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
        events = try events.map { value in
            var event = value; instant = (floor(instant * 1000) + 1) / 1000
            event.createdAt = formatter.string(from: Date(timeIntervalSince1970: instant))
            return try PDFWorkspaceEvent.decodeValidated(event.encoded())
        }
        guard try events.reduce(0, { try $0 + $1.encoded().count }) <= 4 * 1024 * 1024 else { throw PDFWorkspaceError.tooLarge }
        return PDFWorkspaceWritePlan(events: events, inverse: inverse, selectedLayer: selection, sourceSHA256: sourceSHA256, route: route)
    }
    @discardableResult private func publish(_ plan: PDFWorkspaceWritePlan) async -> Bool {
        isSaving = true; error = ""; defer { isSaving = false }
        do {
            let snapshot = try await repository.publish(plan.events, expectedSHA256: plan.sourceSHA256)
            apply(snapshot); selectedLayerID = plan.selectedLayer.flatMap { id in projection.layers.contains(where: { $0.id == id }) ? id : nil }
            switch plan.route {
            case 1: if !undoStack.isEmpty { undoStack.removeLast() }; redoStack.append(plan.inverse)
            case 2: if !redoStack.isEmpty { redoStack.removeLast() }; undoStack.append(plan.inverse)
            default: undoStack.append(plan.inverse); redoStack = []
            }
            if undoStack.count > 20 { undoStack.removeFirst(undoStack.count - 20) }
            if redoStack.count > 20 { redoStack.removeFirst(redoStack.count - 20) }
            canUndo = !undoStack.isEmpty; canRedo = !redoStack.isEmpty
            pending = nil; hasPendingWrite = false; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func activateReader() { readerSuspended = false }
    func suspendReader() {
        guard !isSaving, !hasPendingWrite, !interactionActive, !imageExcerptActive, textDraft == nil else { return }
        if let pdfView, pdfView.document != nil {
            zoom = pdfView.scaleFactor
            if let current = pdfView.currentPage, let document = pdfView.document { page = document.index(for: current)+1 }
        }
        readAloud.stop()
        readerSuspended = true; reloadID = nil; isLoading = false
        temporaryTranslation.close(); captureSource.view = nil; pdfView = nil; document = nil
        needsRefresh = true
    }
    func cancelTranslations() { temporaryTranslation.cancelRequest(); translationJob.cancel() }
    func endReading() { readAloud.stop(); temporaryTranslation.close(); translationJob.cancel(); tool = .read }
}
