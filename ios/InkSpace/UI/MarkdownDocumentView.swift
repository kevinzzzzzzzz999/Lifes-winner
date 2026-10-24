import SwiftUI
import PDFKit
import UIKit

/// Editing affects only Markdown source. Existing annotation pages keep their original layout.
struct MarkdownDocumentView: View {
    let service: MarkdownDocumentService
    let relativePath: String
    var allowsSourceEditing = UIDevice.current.userInterfaceIdiom != .phone
    let onSaved: (MarkdownDocumentSnapshot) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var snapshot: MarkdownDocumentSnapshot?
    @State private var text = ""
    @State private var textHistory = DraftTextHistory()
    @State private var mode = ReaderMode.reading
    @State private var preview: MarkdownPDFResult?
    @State private var previewRevision = 0
    @State private var isLoading = true
    @State private var isRendering = false
    @State private var isSaving = false
    @State private var message: String?
    @State private var showCloseConfirmation = false
    @State private var selection = MarkdownReadingSelectionModel()

    private enum ReaderMode: String, CaseIterable {
        case reading = "阅读", source = "原文"
        var title: String {
            switch self {
            case .reading: String(localized: "阅读")
            case .source: String(localized: "原文")
            }
        }
    }
    private var hasChanges: Bool { snapshot.map { text != $0.text } ?? false }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker(String(localized: "显示方式"), selection: $mode) {
                    ForEach(ReaderMode.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding()
                .accessibilityIdentifier("markdown.mode")
                .disabled(isLoading || isSaving)
                if let message {
                    Text(message).font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(.bottom, 8)
                        .accessibilityIdentifier("markdown.status")
                }
                if isLoading {
                    ProgressView(String(localized: "正在读取原文…")).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if snapshot == nil {
                    ContentUnavailableView(String(localized: "原文暂不可用"), systemImage: "doc.text.magnifyingglass",
                                           description: Text(String(localized: "请确认文件仍在仓库中，并已从 iCloud 下载。")))
                } else if mode == .source {
                    if allowsSourceEditing {
                    HStack {
                        Button(String(localized: "撤销"), systemImage: "arrow.uturn.backward") { if let value = textHistory.undo() { text = value } }
                            .disabled(!textHistory.canUndo || isSaving).accessibilityIdentifier("markdown.undo")
                        Button(String(localized: "重做"), systemImage: "arrow.uturn.forward") { if let value = textHistory.redo() { text = value } }
                            .disabled(!textHistory.canRedo || isSaving).accessibilityIdentifier("markdown.redo")
                        Spacer()
                    }.buttonStyle(.bordered).padding(.horizontal)
                    TextEditor(text: $text)
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .padding(.horizontal, 8)
                        .disabled(isSaving)
                        .accessibilityIdentifier("markdown.editor")
                    Text(String(localized: "保存会修改这份 Markdown 原文。白板上已有的手写批注页保留原排版；需要新页面时请重新展开。"))
                        .font(.footnote).foregroundStyle(.secondary).padding()
                    } else {
                        ScrollView {
                            Text(text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading).padding()
                        }.accessibilityIdentifier("markdown.sourceText")
                    }
                } else {
                    readingPane
                }
            }
            .navigationTitle((relativePath as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "关闭")) {
                        if hasChanges { showCloseConfirmation = true } else { dismiss() }
                    }
                    .disabled(isSaving)
                    .accessibilityIdentifier("markdown.close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if allowsSourceEditing {
                    Button(isSaving ? String(localized: "正在保存…") : String(localized: "保存原文")) { save(closeAfter: false) }
                        .disabled(snapshot == nil || !hasChanges || isSaving)
                        .accessibilityIdentifier("markdown.save")
                    }
                }
            }
            .interactiveDismissDisabled(hasChanges || isSaving)
            .confirmationDialog(String(localized: "保留当前编辑？"), isPresented: $showCloseConfirmation, titleVisibility: .visible) {
                Button(String(localized: "保存并关闭")) { save(closeAfter: true) }
                Button(String(localized: "放弃编辑并关闭"), role: .destructive) { dismiss() }
                Button(String(localized: "继续编辑"), role: .cancel) { }
            } message: { Text(String(localized: "尚未保存的编辑只保留在当前窗口中。")) }
            .task(id: relativePath) { await load() }
            .task(id: previewRevision) { await renderPreview() }
            .onChange(of: mode) { _, _ in previewRevision += 1 }
            .onChange(of: text) { _, value in textHistory.track(value) }
        }
        .opensExternalLinksInApp()
    }

    @ViewBuilder private var readingPane: some View {
        if isRendering {
            ProgressView(String(localized: "正在排版…")).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let preview {
            HStack(spacing: 12) {
                Button(String(localized: "选择文字"), systemImage: "text.cursor") { selection.reveal?() }
                    .accessibilityIdentifier("markdown.selectText")
                Button(String(localized: "复制所选文字"), systemImage: "doc.on.doc") { selection.copy?() }
                    .disabled(!selection.hasSelection).accessibilityIdentifier("markdown.copySelectedText")
                Spacer(minLength: 0)
            }.buttonStyle(.bordered).padding(.horizontal).padding(.bottom, 6)
            Text(selection.status.isEmpty ? String(localized: "长按正文选择；图片里的文字请先点“选择文字”。") : selection.status)
                .font(.caption2).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal).padding(.bottom, 6)
                .accessibilityIdentifier("markdown.textSelectionStatus")
            MarkdownPDFReader(data: preview.data, model: selection)
                .accessibilityIdentifier("markdown.preview")
            if !preview.warnings.isEmpty {
                ScrollView {
                    Text(preview.warnings.joined(separator: "\n"))
                        .font(.footnote).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }.frame(maxHeight: 100).accessibilityIdentifier("markdown.warnings")
            }
            if hasChanges { Text(String(localized: "正在阅读未保存的编辑")).font(.footnote).foregroundStyle(.secondary).padding(8) }
        } else {
            ContentUnavailableView {
                Label(String(localized: "预览暂不可用"), systemImage: "doc.text")
            } description: { Text(String(localized: "原文仍可阅读和编辑。")) }
            actions: {
                Button(String(localized: "重试排版")) { previewRevision += 1 }
                Button(String(localized: "查看原文")) { mode = .source }
            }
        }
    }

    @MainActor private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let value = try await service.load(relativePath: relativePath)
            try Task.checkCancellation()
            snapshot = value; text = value.text; textHistory.reset(text); message = nil
            previewRevision += 1
        } catch is CancellationError { }
        catch { DiagnosticsCenter.shared.record(code: .fileOperationFailed, operation: .fileAccess, error: error); message = error.localizedDescription }
    }

    @MainActor private func renderPreview() async {
        guard mode == .reading, let snapshot else { return }
        isRendering = true
        let revision = previewRevision
        do {
            let draft = try MarkdownDocumentService.snapshot(data: snapshot.bytes(replacingText: text), relativePath: relativePath)
            let result = try await service.renderPDF(snapshot: draft)
            try Task.checkCancellation()
            guard revision == previewRevision else { return }
            preview = result
            message = nil
        } catch is CancellationError { }
        catch { if revision == previewRevision { DiagnosticsCenter.shared.record(code: .documentRenderFailed, operation: .renderDocument, error: error); preview = nil; message = error.localizedDescription } }
        if revision == previewRevision { isRendering = false }
    }

    @MainActor private func save(closeAfter: Bool) {
        guard allowsSourceEditing, !isSaving, let snapshot else { return }
        isSaving = true
        let draft = text
        Task { @MainActor in
            do {
                let saved = try await service.save(text: draft, basedOn: snapshot)
                self.snapshot = saved; text = saved.text
                message = String(localized: "原文已保存。已有手写批注页保持原排版。")
                isSaving = false
                onSaved(saved)
                if closeAfter { dismiss() }
            } catch {
                DiagnosticsCenter.shared.record(code: .sourceEditFailed, operation: .editSource, error: error)
                isSaving = false
                message = error.localizedDescription
                // A conflict must never discard or reload the user's unsaved draft.
                mode = .source
            }
        }
    }
}

@MainActor @Observable
private final class MarkdownReadingSelectionModel {
    var status = ""
    var hasSelection = false
    @ObservationIgnored var owner: UUID?
    @ObservationIgnored var reveal: (() -> Void)?
    @ObservationIgnored var copy: (() -> Void)?
}

/// Uses the same OCR worker, generation checks and UIKit selection as the PDF workspace.
/// PDFKit continues to select native text until the reader explicitly requests image text.
private struct MarkdownPDFReader: UIViewRepresentable {
    let data: Data
    let model: MarkdownReadingSelectionModel
    @Environment(\.openURL) private var openURL
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.delegate = context.coordinator
        context.coordinator.openURL = { openURL($0) }
        context.coordinator.attach(to: view)
        return view
    }
    func updateUIView(_ view: PDFView, context: Context) {
        context.coordinator.openURL = { openURL($0) }
        context.coordinator.setData(data)
    }
    static func dismantleUIView(_ view: PDFView, coordinator: Coordinator) { coordinator.stop() }

    @MainActor final class Coordinator: NSObject, PDFViewDelegate {
        let identity = UUID()
        let model: MarkdownReadingSelectionModel
        private weak var view: PDFView?
        private var data: Data?
        private var revision = 0
        private var stopped = false
        private var installingDocument = false
        private var displayLink: CADisplayLink?
        private var inlineSelection: BoardInlineTextSelection?
        private weak var analysisPage: PDFPage?
        private weak var explicitOCRPage: PDFPage?
        private var pageHasNativeText = false
        private var nativeHasSelection = false
        private var lastPublishedSelection = false
        private var selectionScrollViews: [(UIScrollView, Int)] = []
        var openURL: ((URL) -> Void)?

        init(model: MarkdownReadingSelectionModel) { self.model = model; super.init() }
        func attach(to view: PDFView) {
            self.view = view
            model.owner = identity
            model.reveal = { [weak self] in self?.reveal() }
            model.copy = { [weak self] in self?.copy() }
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped, self.model.owner == self.identity else { return }
                self.model.status = ""; self.model.hasSelection = false
            }
            let selection = BoardInlineTextSelection(content: view)
            inlineSelection = selection
            selection.capture = { [weak self] key in self?.capture(key) }
            selection.canInteract = { [weak self] point in
                guard let self, let view = self.view, self.selectionKey != nil,
                      !self.isNavigating(includingTracking: false),
                      let page = view.page(for: point, nearest: false) else { return false }
                return page === self.analysisPage
            }
            selection.onStatus = { [weak self] status in
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.stopped, self.model.owner == self.identity,
                          self.inlineSelection?.currentStatus == status else { return }
                    self.model.status = status.replacingOccurrences(of: "白板", with: "页面")
                        .replacingOccurrences(of: "board", with: "page")
                }
            }
            selection.onSelectionChanged = { [weak self] _ in
                DispatchQueue.main.async { [weak self] in
                    guard let self, !self.stopped else { return }
                    // Do not clear PDFKit selection here: that also dismisses Live Text.
                    self.synchronizeSelectionNavigation()
                    self.publishSelection()
                }
            }
            NotificationCenter.default.addObserver(self, selector: #selector(nativeSelectionChanged),
                name: .PDFViewSelectionChanged, object: view)
            let pulse = MarkdownPDFSelectionPulse(); pulse.coordinator = self
            let link = CADisplayLink(target: pulse, selector: #selector(MarkdownPDFSelectionPulse.tick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
            link.add(to: .main, forMode: .common); displayLink = link
        }
        func setData(_ data: Data) {
            guard !stopped, self.data != data else { return }
            self.data = data; revision &+= 1; installingDocument = true
            let expectedRevision = revision
            analysisPage = nil; explicitOCRPage = nil; nativeHasSelection = false
            inlineSelection?.update(nil); synchronizeSelectionNavigation(); publishSelection()
            // Assign outside updateUIView: PDFKit may change the first responder.
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped, self.revision == expectedRevision, let view = self.view else { return }
                view.document = PDFDocument(data: data)
                self.installingDocument = false
                if self.model.owner == self.identity { self.model.status = "" }
                self.tick()
            }
        }
        @objc private func nativeSelectionChanged() {
            nativeHasSelection = !(view?.currentSelection?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            publishSelection()
        }
        private func publishSelection() {
            let selected = inlineSelection?.hasSelection == true || nativeHasSelection
            guard selected != lastPublishedSelection else { return }
            lastPublishedSelection = selected
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.stopped, self.model.owner == self.identity,
                      self.lastPublishedSelection == selected else { return }
                self.model.hasSelection = selected
            }
        }
        func tick() {
            guard !stopped, let view else { return }
            if analysisPage !== view.currentPage {
                explicitOCRPage = nil
                analysisPage = view.currentPage
                pageHasNativeText = !(analysisPage?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            inlineSelection?.update(selectionKey)
            synchronizeSelectionNavigation()
            publishSelection()
        }
        private var selectionKey: BoardTextSelectionSnapshotKey? {
            guard !stopped, !installingDocument, let view, view.window != nil, let document = view.document,
                  let page = view.currentPage, page === analysisPage,
                  !pageHasNativeText || page === explicitOCRPage else { return nil }
            let pageRect = view.convert(page.bounds(for: .cropBox), from: page)
            var key = BoardTextSelectionSnapshotKey(sessionID: identity, boardID: identity,
                size: view.bounds.size, offset: CGPoint(x: -pageRect.minX, y: -pageRect.minY),
                zoom: view.scaleFactor, documentRevision: revision, updatedAt: Date(timeIntervalSinceReferenceDate: 0),
                previewEpoch: document.index(for: page), imageRevision: 0, renderedRevision: 0)
            key.prefersHighResolution = page === explicitOCRPage
            return key
        }
        private func isNavigating(includingTracking: Bool) -> Bool {
            func moving(_ view: UIView) -> Bool {
                if let scroll = view as? UIScrollView,
                   scroll.isDragging || scroll.isDecelerating || scroll.isZooming || (includingTracking && scroll.isTracking) { return true }
                return view.subviews.contains(where: moving)
            }
            return view.map(moving) ?? false
        }
        private func capture(_ key: BoardTextSelectionSnapshotKey) -> UIImage? {
            guard selectionKey == key, !isNavigating(includingTracking: true),
                  inlineSelection?.hasSelection != true, let view, let page = analysisPage, key.isValid else { return nil }
            let frame = view.convert(page.bounds(for: .cropBox), from: page)
            return InlinePDFTextCapture.image(page: page, pageFrame: frame, viewport: view.bounds, scale: key.renderScale)
        }

        private func reveal() {
            guard !stopped, !installingDocument, let view, view.document != nil else { return }
            tick()
            explicitOCRPage = view.currentPage
            if inlineSelection?.hasSelection != true { view.clearSelection() }
            tick()
            _ = inlineSelection?.revealText()
        }
        private func copy() {
            guard !stopped, !installingDocument, let view, view.document != nil else { return }
            tick()
            let copied: Bool
            if inlineSelection?.hasSelection == true {
                copied = inlineSelection?.copySelection() == true
            } else if let text = view.currentSelection?.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                UIPasteboard.general.string = text; copied = true
            } else { copied = false }
            model.status = copied ? String(localized: "已复制所选文字。") : String(localized: "请先长按页面文字并调整选区。")
        }
        private func synchronizeSelectionNavigation() {
            if !stopped, inlineSelection?.hasSelection == true, let view {
                func visit(_ candidate: UIView) {
                    if let scroll = candidate as? UIScrollView,
                       !selectionScrollViews.contains(where: { $0.0 === scroll }) {
                        selectionScrollViews.append((scroll, scroll.panGestureRecognizer.minimumNumberOfTouches))
                        scroll.panGestureRecognizer.minimumNumberOfTouches = 2
                    }
                    candidate.subviews.forEach(visit)
                }
                visit(view)
            } else {
                for (scroll, minimum) in selectionScrollViews { scroll.panGestureRecognizer.minimumNumberOfTouches = minimum }
                selectionScrollViews.removeAll()
            }
        }
        func stop() {
            guard !stopped else { return }
            stopped = true
            displayLink?.invalidate(); displayLink = nil
            NotificationCenter.default.removeObserver(self)
            inlineSelection?.tearDown(); inlineSelection = nil
            synchronizeSelectionNavigation()
            view?.delegate = nil; view?.document = nil; view = nil; data = nil; openURL = nil
            if model.owner == identity {
                model.owner = nil; model.reveal = nil; model.copy = nil
                DispatchQueue.main.async { [weak model] in
                    guard let model, model.owner == nil else { return }
                    model.status = ""; model.hasSelection = false
                }
            }
        }
        func pdfViewWillClick(onLink sender: PDFView, with url: URL) {
            guard ["https", "http", "mailto", "obsidian"].contains(url.scheme?.lowercased() ?? "") else { return }
            openURL?(url)
        }
        deinit { displayLink?.invalidate() }
    }
}

@MainActor private final class MarkdownPDFSelectionPulse: NSObject {
    weak var coordinator: MarkdownPDFReader.Coordinator?
    @objc func tick() { coordinator?.tick() }
}
