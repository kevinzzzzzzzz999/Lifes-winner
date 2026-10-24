import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Clipboard access happens only after the user presses the system Paste button.
struct BoardPasteView: View {
    let store: BoardStore
    @Environment(\.dismiss) private var dismiss
    @State private var format = "richText"
    @StateObject private var session: BoardPasteSession
    private var zh: Bool { Locale.preferredLanguages.first?.hasPrefix("zh") == true }

    init(store: BoardStore) {
        self.store = store
        _session = StateObject(wrappedValue: BoardPasteSession(store: store))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(zh ? "文字格式" : "Text format") {
                    Picker(zh ? "粘贴为" : "Paste as", selection: $format) {
                        Text(zh ? "正常文字 / 表格" : "Text / table").tag("richText")
                        Text("Markdown").tag("markdown")
                        Text("LaTeX").tag("latex")
                        Text("Python").tag("python")
                    }.disabled(session.isBusy)
                }
                Section {
                    PasteButton(supportedContentTypes: [.item]) { providers in
                        session.start(providers, format: format)
                    }.disabled(session.isBusy || store.isBusy)
                        .accessibilityIdentifier("paste.start")
                    Text(zh ? "支持文字、图片和资料文件。文件和图片会保存到当前资料库；代码不会自动运行。" : "Paste text, images and supported files. Attachments are saved in the current library. Code never runs automatically.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if session.isBusy {
                        HStack {
                            ProgressView()
                            Text(session.detail).font(.footnote)
                        }.accessibilityIdentifier("paste.progress")
                        if session.canCancel {
                            Button(zh ? "取消粘贴" : "Cancel paste", role: .cancel) {
                                session.cancel(closeAfter: false)
                            }.disabled(session.cancelRequested)
                                .accessibilityIdentifier("paste.cancel")
                        }
                    }
                    if !session.message.isEmpty {
                        Text(session.message).accessibilityIdentifier("paste.result")
                    }
                }
            }
            .navigationTitle(zh ? "粘贴到白板" : "Paste onto board")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(session.phase == .saving ? (zh ? "返回白板" : "Back to board") : (zh ? "关闭" : "Close")) {
                        if session.canCancel { session.cancel(closeAfter: true) }
                        else { dismiss() }
                    }.disabled(session.canCancel && session.cancelRequested)
                        .accessibilityIdentifier("paste.close")
                }
            }
            .interactiveDismissDisabled(session.isBusy)
            .onChange(of: session.shouldDismiss) { _, value in if value { dismiss() } }
            .onDisappear { session.cancel(closeAfter: false) }
        }
    }
}

/// Retains the operation and owns busy state until cancellation/cleanup has finished.
/// Once content has entered the board, it is saved rather than discarded by closing UI.
@MainActor final class BoardPasteSession: ObservableObject {
    enum Phase { case idle, loading, preparing, saving }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var message = ""
    @Published private(set) var detail = ""
    @Published private(set) var cancelRequested = false
    @Published private(set) var shouldDismiss = false
    private let store: BoardStore
    private var task: Task<Void, Never>?
    private var operationID: UUID?
    private var closeAfterCancel = false
    private var zh: Bool { Locale.preferredLanguages.first?.hasPrefix("zh") == true }
    var isBusy: Bool { phase != .idle }
    var canCancel: Bool { phase == .loading || phase == .preparing }

    init(store: BoardStore) { self.store = store }

    func start(_ providers: [NSItemProvider], format: String) {
        guard !isBusy, !store.isBusy, let library = store.library else {
            message = zh ? "请先打开资料库和白板。" : "Open a library and board first."; return
        }
        guard store.canEditBoardContents else {
            message = zh ? "请先退出仅阅读模式再粘贴。" : "Leave read-only mode before pasting."; return
        }
        guard !providers.isEmpty, providers.count <= 100 else {
            message = BoardPasteError.unsupported.localizedDescription; return
        }
        let id = UUID(), canvas = store.canvasSessionID, board = store.document.id
        let point = store.insertionPoint ?? CGPoint(x: max(0, store.viewportCenter.x - 280), y: max(0, store.viewportCenter.y - 180))
        operationID = id; phase = .loading; store.isBusy = true
        message = ""; cancelRequested = false; closeAfterCancel = false; shouldDismiss = false
        detail = zh ? "正在读取剪贴板…" : "Reading clipboard…"
        task = Task { await run(providers, format: format, id: id, library: library, canvas: canvas, board: board, point: point) }
    }

    func cancel(closeAfter: Bool) {
        guard canCancel else { return }
        closeAfterCancel = closeAfterCancel || closeAfter
        cancelRequested = true
        detail = zh ? "正在取消…" : "Cancelling…"
        task?.cancel()
    }

    private func run(_ providers: [NSItemProvider], format: String, id: UUID,
                     library: DocumentLibrary, canvas: UUID, board: UUID, point: CGPoint) async {
        let publication = library.beginPublication()
        var accepted = false
        var staging: BoardPasteStaging?
        defer {
            staging?.close()
            if operationID == id {
                operationID = nil; task = nil; phase = .idle; store.isBusy = false
                if !accepted && closeAfterCancel { shouldDismiss = true }
            }
        }
        do {
            try Task.checkCancellation()
            let folder = try BoardPasteStaging(); staging = folder
            var urls: [URL] = [], texts: [(String, String?)] = []
            let budget = BoardClipboardReadBudget(seconds: 120)
            for (index, provider) in providers.enumerated() {
                try Task.checkCancellation()
                detail = zh ? "正在读取第 \(index + 1) / \(providers.count) 项…" : "Reading item \(index + 1) / \(providers.count)…"
                if let value = try await BoardClipboardLoader.load(provider, staging: folder, index: index, budget: budget) {
                    switch value {
                    case .file(let url): urls.append(url)
                    case .text(let text, let html): texts.append((text, html))
                    }
                } else { throw BoardPasteError.unsupported }
            }
            try checkCurrent(id: id, library: library, canvas: canvas, board: board)
            phase = .preparing
            detail = zh ? "正在准备白板内容…" : "Preparing board content…"
            var insertion = point
            var items: [BoardItem] = []
            if !urls.isEmpty {
                let documents = try await library.importDocuments(from: urls)
                try checkCurrent(id: id, library: library, canvas: canvas, board: board)
                items = try await library.makeInsertionItems(documents: documents, at: insertion,
                    canvasSize: store.document.canvasWidth, publicationID: publication)
                if let last = items.last { insertion.y = last.y + last.height + 48 }
            }
            for (text, html) in texts {
                let link = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines))
                let validLink = link.flatMap { ["https", "http"].contains($0.scheme?.lowercased() ?? "") && $0.host != nil ? $0.absoluteString : nil }
                let item = BoardItem(kind: .text, x: insertion.x, y: insertion.y, width: 560, height: 300,
                    title: String(text.prefix(70)), text: text, textFormat: format,
                    richTextHTML: format == "richText" ? html : nil, url: validLink)
                items.append(item); insertion.y += 348
            }
            try checkCurrent(id: id, library: library, canvas: canvas, board: board)
            guard !items.isEmpty else { throw BoardPasteError.unsupported }
            var candidate = store.document; candidate.items.append(contentsOf: items)
            try candidate.validate()
            // No suspension between this final guard and the atomic board acceptance.
            store.addItems(items); store.selectedIDs = Set(items.map(\.id)); store.insertionPoint = nil
            accepted = true; phase = .saving
            detail = zh ? "正在保存…" : "Saving…"
            await library.finishPublication(publication, accepted: true)
            let saved = await store.save()
            message = saved ? (zh ? "已粘贴并保存。" : "Pasted and saved.") : (zh ? "内容已加入白板，保存尚未完成，请保留当前白板并重试保存。" : "Added to board; saving is pending. Keep this board open and retry saving.")
            if saved { shouldDismiss = true }
        } catch {
            if !accepted { await library.finishPublication(publication, accepted: false) }
            if error is CancellationError || Task.isCancelled {
                message = zh ? "已取消粘贴，白板内容未改变。" : "Paste cancelled. Board content is unchanged."
            } else { message = error.localizedDescription }
        }
    }

    private func checkCurrent(id: UUID, library: DocumentLibrary, canvas: UUID, board: UUID) throws {
        try Task.checkCancellation()
        guard operationID == id, store.library === library, canvas == store.canvasSessionID,
              board == store.document.id, store.canEditBoardContents else { throw CancellationError() }
    }
}

private enum BoardPasteError: LocalizedError {
    case unsupported, oversized
    var errorDescription: String? {
        let zh = Locale.preferredLanguages.first?.hasPrefix("zh") == true
        switch self {
        case .unsupported: return zh ? "剪贴板没有可用内容。请重新复制文字、图片或支持的资料文件。" : "No supported content. Copy text, an image or a supported file and try again."
        case .oversized: return zh ? "内容过大，请通过添加资料导入。" : "This content is too large. Use Add materials instead."
        }
    }
}

enum BoardClipboardValue { case file(URL), text(String, String?) }

enum BoardClipboardLoader {
    /// Prefer a file over the text or thumbnail representation of that same item.
    static func load(_ provider: NSItemProvider, staging: BoardPasteStaging, index: Int, budget: BoardClipboardReadBudget = .init(seconds: 120)) async throws -> BoardClipboardValue? {
        try Task.checkCancellation()
        let types = provider.registeredTypeIdentifiers
        let fileType = types.first { identifier in
            guard let type = UTType(identifier), let ext = type.preferredFilenameExtension else { return false }
            return DocumentLibrary.supportedExtensions.contains(ext) && !type.conforms(to: .text) && !type.conforms(to: .image)
        } ?? types.first { identifier in
            guard let type = UTType(identifier), let ext = type.preferredFilenameExtension else { return false }
            return DocumentLibrary.supportedExtensions.contains(ext) && DocumentLibrary.supportedExtensions.contains(((provider.suggestedName ?? "") as NSString).pathExtension.lowercased())
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            let bytes = try await data(provider, type: UTType.fileURL.identifier, budget: budget)
            try Task.checkCancellation()
            if let url = URL(dataRepresentation: bytes, relativeTo: nil), url.isFileURL {
                let target = try await BoardClipboardRequest.copyCoordinatedFile(source: url,
                    staging: staging, filename: "\(index)-" + url.lastPathComponent.replacingOccurrences(of: "\\", with: "_"),
                    timeout: try budget.requestTimeout())
                return .file(target)
            }
        }
        if let fileType {
            let type = UTType(fileType)
            let name = provider.suggestedName ?? "Attachment.\(type?.preferredFilenameExtension ?? "dat")"
            var safeName = (name as NSString).lastPathComponent.replacingOccurrences(of: "\\", with: "_")
            if (safeName as NSString).pathExtension.isEmpty { safeName += "." + (type?.preferredFilenameExtension ?? "dat") }
            let target = try await BoardClipboardRequest.copyTemporaryFile(timeout: try budget.requestTimeout(), staging: staging,
                filename: "\(index)-" + safeName) { reply in
                provider.loadFileRepresentation(forTypeIdentifier: fileType, completionHandler: reply)
            }
            return .file(target)
        }
        if provider.canLoadObject(ofClass: UIImage.self) {
            let image: UIImage = try await BoardClipboardRequest.awaitResult(timeout: try budget.requestTimeout()) { reply in
                provider.loadObject(ofClass: UIImage.self) { object, error in
                    if let image = object as? UIImage { reply(.success(image)) }
                    else { reply(.failure(error ?? BoardPasteError.unsupported)) }
                }
            }
            try Task.checkCancellation()
            // Encoding and staging writes stay off the UI actor. Late encoding
            // completion is ignored by the request and cannot insert an image.
            let bytes: Data = try await BoardClipboardRequest.awaitResult(timeout: try budget.requestTimeout()) { reply in
                guard let bytes = image.pngData(), bytes.count <= 80 * 1024 * 1024 else {
                    reply(.failure(BoardPasteError.oversized)); return nil
                }
                reply(.success(bytes)); return nil
            }
            try Task.checkCancellation()
            let target = try await BoardClipboardRequest.writeData(bytes, staging: staging, filename: "\(index)-Image.png", timeout: try budget.requestTimeout())
            return .file(target)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.html.identifier) {
            let bytes = try await data(provider, type: UTType.html.identifier, budget: budget)
            guard bytes.count <= 2 * 1024 * 1024, let html = String(data: bytes, encoding: .utf8) else { throw BoardPasteError.oversized }
            let fallback = provider.hasItemConformingToTypeIdentifier(UTType.utf8PlainText.identifier)
                ? String(data: try await data(provider, type: UTType.utf8PlainText.identifier, budget: budget), encoding: .utf8) ?? "" : ""
            try Task.checkCancellation()
            _ = try budget.requestTimeout()
            let safe = try await BoardRichTextRenderer.normalize(html: html, text: fallback)
            _ = try budget.requestTimeout()
            try Task.checkCancellation()
            return .text(safe.text, safe.html)
        }
        for type in [UTType.utf8PlainText.identifier, UTType.plainText.identifier, UTType.url.identifier] where provider.hasItemConformingToTypeIdentifier(type) {
            let bytes = try await data(provider, type: type, budget: budget)
            guard bytes.count <= 2 * 1024 * 1024 else { throw BoardPasteError.oversized }
            try Task.checkCancellation()
            if let text = String(data: bytes, encoding: .utf8), !text.isEmpty { return .text(text, nil) }
        }
        return nil
    }
    private static func data(_ provider: NSItemProvider, type: String, budget: BoardClipboardReadBudget) async throws -> Data {
        try await BoardClipboardRequest.awaitResult(timeout: try budget.requestTimeout()) { reply in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                if let data { reply(.success(data)) }
                else { reply(.failure(error ?? BoardPasteError.unsupported)) }
            }
        }
    }
}

/// A batch shares a monotonic acquisition budget; 100 slow representations do
/// not each receive a new full deadline. Importing/saving keep their own guards.
struct BoardClipboardReadBudget {
    private let deadline: TimeInterval
    init(seconds: TimeInterval) { deadline = ProcessInfo.processInfo.systemUptime + seconds }
    func requestTimeout() throws -> TimeInterval {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining.isFinite, remaining > 0 else { throw BoardClipboardRequestError.timedOut }
        return min(30, remaining)
    }
}
