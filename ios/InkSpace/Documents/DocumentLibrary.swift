import Foundation
import UIKit
import PDFKit
import QuickLookThumbnailing

struct VaultDocument: Identifiable, Hashable, Sendable {
    var id: String { relativePath }
    let relativePath: String
    let title: String
    let fileExtension: String
    let byteCount: Int64
    let requiresDownload: Bool

    var isVideo: Bool { BoardVideo.extensions.contains(fileExtension) }
    var isPDF: Bool { fileExtension == "pdf" }
    var isImage: Bool { DocumentLibrary.imageExtensions.contains(fileExtension) }
    var isExcel: Bool { fileExtension == "xls" || fileExtension == "xlsx" || fileExtension == "xlsm" }
    var isOffice: Bool { DocumentLibrary.officeExtensions.contains(fileExtension) }
    var isMarkdown: Bool { DocumentLibrary.markdownExtensions.contains(fileExtension) }
    var symbol: String {
        switch fileExtension {
        case "pdf": return "doc.richtext"
        case "ppt", "pptx": return "rectangle.stack"
        case "xls", "xlsx", "xlsm": return "tablecells"
        case "png", "jpg", "jpeg": return "photo"
        case "mp4", "mov", "m4v": return "play.rectangle"
        default: return "doc.text"
        }
    }
}

struct VaultFolder: Identifiable, Hashable, Sendable {
    var id: String { relativePath }
    let relativePath: String
    let title: String
}

struct VaultDirectoryListing: Sendable {
    let folders: [VaultFolder]
    let documents: [VaultDocument]
    let warning: String?
}

enum DocumentLibraryError: LocalizedError {
    case outsideVault, missingFile, unreadablePDF, lockedPDF, missingConvertedPDF(String)
    case noPages, invalidPage(Int), cancelled, thumbnailUnavailable, invalidGeometry
    case unsupportedFile(String), unsafeAttachmentFolder, copyFailed, invalidPublication

    var errorDescription: String? {
        switch self {
        case .outsideVault: return String(localized: "文件路径不在已授权的 Obsidian 文件夹内。")
        case .missingFile: return String(localized: "原文件暂不可访问。请检查网络或文件夹授权后重试。")
        case .unreadablePDF: return String(localized: "无法读取 PDF。请确认文件已下载完整且未损坏。")
        case .lockedPDF: return String(localized: "PDF 已加密。请先在其他 App 中解锁并保存可阅读版本。")
        case .missingConvertedPDF(let name): return String(localized: "请先在 Office、Keynote 或其他文档 App 中导出 PDF，保存为同一文件夹内的“\(name)”。此功能不会自动转换 Office 文件。")
        case .noPages: return String(localized: "这个 PDF 没有可展开的页面。")
        case .invalidPage(let page): return String(localized: "PDF 中没有第 \(page) 页，原文档可能已修改。")
        case .cancelled: return String(localized: "预览已取消。")
        case .thumbnailUnavailable: return String(localized: "系统暂时无法生成预览；仍可打开原文件。")
        case .invalidGeometry: return String(localized: "画布位置或 PDF 页尺寸无效。")
        case .unsupportedFile(let name): return String(localized: "“\(name)”不是支持的文档、PNG/JPEG 图片或 MP4/MOV/M4V 视频。")
        case .unsafeAttachmentFolder: return String(localized: "无法安全地使用 Attachments/InkSpace 附件文件夹。请检查它是否是正常文件夹。")
        case .copyFailed: return String(localized: "无法将外部文件保存到附件文件夹。原文件没有移动，请检查可用空间和文件夹权限。")
        case .invalidPublication: return String(localized: "本次添加已结束，请重新选择文件。")
        }
    }
}

/// NSFileCoordinator.cancel() is thread-safe and unblocks pending coordination.
/// Accessors also check this flag because cancellation can race with their start.
private final class DocumentOperationControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var reporting = true
    private var coordinator: NSFileCoordinator?

    func checkCancellation() throws {
        lock.lock(); let value = cancelled; lock.unlock()
        if value { throw CancellationError() }
    }
    func use(_ value: NSFileCoordinator) throws {
        lock.lock()
        let wasCancelled = cancelled
        if !wasCancelled { coordinator = value }
        lock.unlock()
        if wasCancelled { value.cancel(); throw CancellationError() }
    }
    func clearCoordinator() {
        lock.lock(); coordinator = nil; lock.unlock()
    }
    func cancel() {
        lock.lock(); cancelled = true; reporting = false; let current = coordinator; lock.unlock()
        current?.cancel()
    }
    func finishReporting() { lock.lock(); reporting = false; lock.unlock() }
    var canReport: Bool { lock.lock(); defer { lock.unlock() }; return reporting && !cancelled }
}

private struct DocumentPage {
    let sourcePath: String
    let originalSourcePath: String?
    let originalSourceSHA256: String?
    let title: String
    let page: Int
    let size: CGSize
}

/// The folder picker or bookmark owner supplies the original security-scoped URL.
/// This lease only balances access it acquired itself; it does not own the caller's lease.
// Immutable lease: background callbacks only retain it; acquire/release is balanced by lifetime.
private final class DocumentSecurityScope: @unchecked Sendable {
    let url: URL
    let acquired: Bool
    init(_ url: URL) {
        self.url = url
        acquired = url.startAccessingSecurityScopedResource()
    }
    deinit {
        if acquired { url.stopAccessingSecurityScopedResource() }
    }
}

/// Documents are kept on one serial worker so PDFKit objects are never shared concurrently.
private final class PDFThumbnailWorker {
    let queue = DispatchQueue(label: "InkSpace.document-thumbnails", qos: .userInitiated)
    private let documents = NSCache<NSString, PDFDocument>()
    private var recentDocuments: [String] = []

    init() { documents.countLimit = 2 }

    func image(url: URL, revision: String, pageNumber: Int, size: CGSize, scope: DocumentSecurityScope, annotationOwners: Set<UUID>,
               completion: @escaping (Result<UIImage, Error>) -> Void) {
        queue.async { [self, scope] in
            _ = scope // Hold the authorized folder lease until this background read completes.
            autoreleasepool {
                let document: PDFDocument
                if let cached = documents.object(forKey: revision as NSString) {
                    document = cached
                } else if let opened = PDFDocument(url: url) {
                    document = opened
                    recentDocuments.removeAll { $0 == revision }
                    while recentDocuments.count >= 2 {
                        documents.removeObject(forKey: recentDocuments.removeFirst() as NSString)
                    }
                    documents.setObject(opened, forKey: revision as NSString)
                } else {
                    completion(.failure(DocumentLibraryError.unreadablePDF)); return
                }
                recentDocuments.removeAll { $0 == revision }
                recentDocuments.append(revision)
                guard !document.isLocked else {
                    completion(.failure(DocumentLibraryError.lockedPDF)); return
                }
                guard pageNumber > 0, let page = document.page(at: pageNumber - 1) else {
                    completion(.failure(DocumentLibraryError.invalidPage(pageNumber))); return
                }
                BoardPDFAnnotationOwners.hide(in: page, owners: annotationOwners)
                completion(.success(page.thumbnail(of: size, for: .cropBox)))
            }
        }
    }

    func clearCache() {
        queue.async { [self] in
            documents.removeAllObjects()
            recentDocuments.removeAll()
        }
    }
}

private struct DocumentEnumerationResult: Sendable {
    let documents: [VaultDocument]
    let warning: String?
}

@MainActor
final class DocumentLibrary {
    nonisolated static let officeExtensions: Set<String> = ["doc", "docx", "xls", "xlsx", "xlsm", "ppt", "pptx"]
    nonisolated static let markdownExtensions: Set<String> = ["md", "markdown"]
    nonisolated static let imageExtensions: Set<String> = ["png", "jpg", "jpeg"]
    nonisolated static let codeExtensions: Set<String> = ["tex", "py", "txt"]
    nonisolated static let supportedExtensions = officeExtensions.union(markdownExtensions).union(imageExtensions).union(BoardVideo.extensions).union(codeExtensions).union(["pdf"])
    let rootURL: URL
    private let scope: DocumentSecurityScope
    private let images = NSCache<NSString, UIImage>()
    private var imageCosts: [String: Int] = [:]
    private var imageLRU: [String] = []
    private let imageBudget = 48 * 1_024 * 1_024
    private let worker = PDFThumbnailWorker()
    private var pending: [String: [(Result<UIImage, Error>) -> Void]] = [:]
    private var quickLookRequests: [String: QLThumbnailGenerator.Request] = [:]
    private var cacheGeneration = 0
    private let enumerationQueue = DispatchQueue(label: "InkSpace.document-enumeration", qos: .userInitiated)
    private let operationsQueue = DispatchQueue(label: "InkSpace.document-operations", qos: .userInitiated)
    private let renderStore: SourceDocumentRenderStore
    private var pendingPublications: Set<UUID> = []
    let markdown: MarkdownDocumentService
    private var enumerationID = UUID()
    private(set) var enumerationWarning: String?
    private(set) var lastExpansionWarnings: [String] = []
    var annotationOwnersToHide = Set<UUID>() {
        didSet { if oldValue != annotationOwnersToHide { clearCache() } }
    }
    /// Preserve the old API for callers that intentionally display one board.
    var annotationOwnerToHide: UUID? {
        get { annotationOwnersToHide.count == 1 ? annotationOwnersToHide.first : nil }
        set { annotationOwnersToHide = newValue.map { Set([$0]) } ?? [] }
    }

    init(rootURL: URL) {
        self.scope = DocumentSecurityScope(rootURL)
        self.rootURL = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        self.renderStore = SourceDocumentRenderStore(rootURL: rootURL)
        self.markdown = MarkdownDocumentService(rootURL: rootURL)
        images.totalCostLimit = 48 * 1_024 * 1_024
        images.countLimit = 32
    }

    /// Returns nil for absolute paths, parent traversal, escaped symlinks, and missing items.
    /// File coordination cannot turn this into protection against an adversarial symlink swap.
    func resolve(relativePath: String) -> URL? {
        VaultPathResolver.resolve(relativePath: relativePath, within: rootURL)
    }

    /// Lists only this directory. Each request owns its warnings; navigating while
    /// another request is pending cannot overwrite the recursive scan's status.
    func listDirectory(relativePath: String = "") async -> VaultDirectoryListing {
        let root = rootURL
        do {
            return try await performOperation { control in
                try Self.readDirectory(relativePath: relativePath, root: root, control: control)
            }
        } catch is CancellationError {
            return VaultDirectoryListing(folders: [], documents: [], warning: String(localized: "文件夹读取已取消。"))
        } catch {
            DiagnosticsCenter.shared.record(code: .fileOperationFailed, operation: .fileAccess, error: error)
            return VaultDirectoryListing(folders: [], documents: [],
                                         warning: String(localized: "无法读取此文件夹：\(error.localizedDescription)"))
        }
    }

    /// Validate the lexical path before resolving it, rejecting intermediate links
    /// too: a link to another location inside the vault is not a browsable folder.
    private nonisolated static func browsableDirectory(relativePath: String, root: URL) throws -> URL {
        if !relativePath.isEmpty {
            guard VaultPathResolver.resolve(relativePath: relativePath, within: root) != nil else {
                throw DocumentLibraryError.outsideVault
            }
        }
        var directory = root
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey]
        let rootValues = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else {
            throw DocumentLibraryError.missingFile
        }
        for component in relativePath.split(separator: "/") {
            directory.appendPathComponent(String(component), isDirectory: true)
            let values = try directory.resourceValues(forKeys: keys)
            guard values.isDirectory == true, values.isSymbolicLink != true,
                  values.isHidden != true, values.isPackage != true else {
                throw DocumentLibraryError.outsideVault
            }
        }
        return directory
    }

    private nonisolated static func readDirectory(relativePath: String, root: URL,
                                                   control: DocumentOperationControl) throws -> VaultDirectoryListing {
        try control.checkCancellation()
        let directory = try browsableDirectory(relativePath: relativePath, root: root)
        let expectedDirectory = directory.standardizedFileURL.resolvingSymlinksInPath()
        let coordinator = NSFileCoordinator()
        try control.use(coordinator)
        defer { control.clearCoordinator() }
        var coordinationError: NSError?
        var result: Result<VaultDirectoryListing, Error>?
        coordinator.coordinate(readingItemAt: directory, options: [], error: &coordinationError) { readable in
            result = Result {
                try control.checkCancellation()
                guard readable.standardizedFileURL.resolvingSymlinksInPath().pathComponents == expectedDirectory.pathComponents else {
                    throw DocumentLibraryError.outsideVault
                }
                _ = try browsableDirectory(relativePath: relativePath, root: root)
                let keys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey]
                // contentsOfDirectory is deliberately nonrecursive. Do not inspect
                // children to decide whether a folder is empty or has usable PDFs.
                let children = try FileManager.default.contentsOfDirectory(
                    at: readable, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])
                var folders: [VaultFolder] = []
                var documents: [VaultDocument] = []
                var failures = 0
                var skippedLinks = 0
                var firstError: String?
                for child in children {
                    try control.checkCancellation()
                    do {
                        let values = try child.resourceValues(forKeys: keys)
                        if values.isSymbolicLink == true { skippedLinks += 1; continue }
                        if values.isHidden == true || values.isPackage == true { continue }
                        let canonicalChild = child.standardizedFileURL.resolvingSymlinksInPath()
                        guard canonicalChild.deletingLastPathComponent().pathComponents == expectedDirectory.pathComponents,
                              let path = Self.relativePath(of: child, within: root) else {
                            throw DocumentLibraryError.outsideVault
                        }
                        if values.isDirectory == true {
                            folders.append(VaultFolder(relativePath: path, title: child.lastPathComponent))
                        } else if values.isRegularFile == true {
                            let ext = child.pathExtension.lowercased()
                            guard supportedExtensions.contains(ext) else { continue }
                            var byteCount: Int64 = 0
                            var requiresDownload = false
                            do {
                                let details = try child.resourceValues(forKeys: [.fileSizeKey, .ubiquitousItemDownloadingStatusKey])
                                byteCount = Int64(details.fileSize ?? 0)
                                requiresDownload = details.ubiquitousItemDownloadingStatus == .notDownloaded
                            } catch {
                                failures += 1
                                if firstError == nil { firstError = error.localizedDescription }
                            }
                            documents.append(VaultDocument(relativePath: path, title: child.lastPathComponent,
                                                           fileExtension: ext, byteCount: byteCount,
                                                           requiresDownload: requiresDownload))
                        } else {
                            failures += 1
                        }
                    } catch {
                        failures += 1
                        if firstError == nil { firstError = error.localizedDescription }
                    }
                }
                try control.checkCancellation()
                var messages: [String] = []
                if failures > 0 { messages.append(String(localized: "有 \(failures) 项信息或路径未能读取，列表可能不完整")) }
                if skippedLinks > 0 { messages.append(String(localized: "已跳过 \(skippedLinks) 个符号链接")) }
                if let firstError { messages.append(firstError) }
                return VaultDirectoryListing(
                    folders: folders.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending },
                    documents: documents.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending },
                    warning: messages.isEmpty ? nil : messages.joined(separator: "。"))
            }
        }
        try control.checkCancellation()
        if let coordinationError { throw coordinationError }
        guard let result else { throw DocumentLibraryError.missingFile }
        return try result.get()
    }

    func enumerateDocuments() async -> [VaultDocument] {
        enumerationWarning = nil
        let requestID = UUID()
        enumerationID = requestID
        let root = rootURL
        let lease = scope
        let result: DocumentEnumerationResult = await withCheckedContinuation { continuation in
            enumerationQueue.async { [lease] in
                _ = lease // Keep folder access alive until the coordinated read completes.
                let result = autoreleasepool { Self.scanDocuments(at: root) }
                continuation.resume(returning: result)
            }
        }
        guard enumerationID == requestID, !Task.isCancelled else { return [] }
        enumerationWarning = result.warning
        return result.documents
    }

    /// All enumeration, metadata and path checks stay on the worker queue. A cloud
    /// provider may need to fetch directory entries while the coordinator waits.
    private nonisolated static func scanDocuments(at root: URL) -> DocumentEnumerationResult {
        let manager = FileManager()
        var documents: [VaultDocument] = []
        var coordinationError: NSError?
        var directoryFailures = 0
        var metadataFailures = 0
        var unresolvedFiles = 0
        var unknownTypes = 0
        var skippedLinks = 0
        var firstError: String?
        let typeKeys: Set<URLResourceKey> = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey]
        NSFileCoordinator().coordinate(readingItemAt: root, options: [], error: &coordinationError) { readableRoot in
            let readableRootComponents = readableRoot.standardizedFileURL.resolvingSymlinksInPath().pathComponents
            guard let enumerator = manager.enumerator(
                at: readableRoot, includingPropertiesForKeys: Array(typeKeys),
                options: [.skipsHiddenFiles, .skipsPackageDescendants],
                errorHandler: { _, error in
                    directoryFailures += 1
                    if firstError == nil { firstError = error.localizedDescription }
                    return true
                }
            ) else {
                directoryFailures += 1
                return
            }
            for case let url as URL in enumerator {
                let ext = url.pathExtension.lowercased()
                guard Self.supportedExtensions.contains(ext) else { continue }
                let values: URLResourceValues
                do {
                    values = try url.resourceValues(forKeys: typeKeys)
                } catch {
                    metadataFailures += 1
                    if firstError == nil { firstError = error.localizedDescription }
                    continue
                }
                if values.isSymbolicLink == true { skippedLinks += 1; continue }
                if values.isDirectory == true { continue }
                guard values.isRegularFile == true else { unknownTypes += 1; continue }
                // Enumeration can return a different filesystem alias than the root
                // (for example /private/tmp versus /tmp). Compare canonical paths.
                let canonicalURL = url.standardizedFileURL.resolvingSymlinksInPath()
                guard canonicalURL.pathComponents.count > readableRootComponents.count,
                      Array(canonicalURL.pathComponents.prefix(readableRootComponents.count)) == readableRootComponents else {
                    unresolvedFiles += 1
                    continue
                }
                let relative = canonicalURL.pathComponents.dropFirst(readableRootComponents.count).joined(separator: "/")
                guard let resolved = VaultPathResolver.resolve(relativePath: relative, within: root),
                      resolved.pathComponents == canonicalURL.pathComponents else {
                    unresolvedFiles += 1
                    continue
                }
                // A missing optional size/cloud property must not hide a readable file.
                var byteCount: Int64 = 0
                var requiresDownload = false
                do {
                    let details = try url.resourceValues(forKeys: [.fileSizeKey, .ubiquitousItemDownloadingStatusKey])
                    byteCount = Int64(details.fileSize ?? 0)
                    requiresDownload = details.ubiquitousItemDownloadingStatus == .notDownloaded
                } catch {
                    metadataFailures += 1
                    if firstError == nil { firstError = error.localizedDescription }
                }
                documents.append(VaultDocument(relativePath: relative, title: url.lastPathComponent,
                                               fileExtension: ext, byteCount: byteCount,
                                               requiresDownload: requiresDownload))
            }
        }
        var messages: [String] = []
        if let coordinationError {
            messages.append(String(localized: "无法读取文件夹：\(coordinationError.localizedDescription)"))
        }
        if directoryFailures > 0 { messages.append(String(localized: "有 \(directoryFailures) 个文件夹未能读取")) }
        if metadataFailures > 0 { messages.append(String(localized: "有 \(metadataFailures) 项文件信息未能读取，列表可能不完整")) }
        if unresolvedFiles > 0 { messages.append(String(localized: "有 \(unresolvedFiles) 个文件路径无效或暂不可访问，已跳过")) }
        if unknownTypes > 0 { messages.append(String(localized: "有 \(unknownTypes) 个项目无法确认文件类型，已跳过")) }
        if skippedLinks > 0 { messages.append(String(localized: "已跳过 \(skippedLinks) 个符号链接")) }
        if let firstError { messages.append(firstError) }
        if directoryFailures + metadataFailures + unresolvedFiles + unknownTypes > 0 || coordinationError != nil {
            messages.append(String(localized: "请在“文件”App 确认文件夹可访问且内容已出现，再点刷新；必要时重新选择仓库。"))
        }
        return DocumentEnumerationResult(
            documents: documents.sorted { $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending },
            warning: messages.isEmpty ? nil : messages.joined(separator: "。")
        )
    }

    /// Makes selected references readable without requiring another user selection.
    /// Coordination materializes cloud content; document bytes are never loaded as a whole.
    func prepareDocuments(_ documents: [VaultDocument], referenceOnly: Bool = false,
                          progress: @escaping @MainActor (String) -> Void = { _ in }) async throws -> [VaultDocument] {
        let selected = Self.sortedUnique(documents)
        let root = rootURL
        return try await performOperation { control in
            var prepared: [VaultDocument] = []
            for (index, document) in selected.enumerated() {
                try control.checkCancellation()
                Self.report(String(localized: "正在准备 \(index + 1)/\(selected.count)：\(document.title) · 云端文件会自动下载"), control: control, progress: progress)
                guard let url = VaultPathResolver.resolve(relativePath: document.relativePath, within: root) else {
                    throw DocumentLibraryError.missingFile
                }
                if document.isVideo || (referenceOnly && !document.isImage && !Self.codeExtensions.contains(document.fileExtension)) {
                    // A collapsed document card needs its path and metadata, not
                    // the complete cloud file. Reading/expanding coordinates and
                    // downloads the actual content when the user requests it.
                    prepared.append(try Self.document(at: url, relativePath: document.relativePath))
                    continue
                }
                prepared.append(try Self.withReadableFile(url, control: control) { readable in
                    // Opening a coordinated file ensures the provider has supplied readable content.
                    let handle = try FileHandle(forReadingFrom: readable)
                    defer { try? handle.close() }
                    _ = try handle.read(upToCount: 1)
                    return try Self.document(at: readable, relativePath: document.relativePath)
                })
            }
            return prepared
        }
    }

    /// Only files outside the authorized vault are copied. The source is never moved.
    /// A unique batch folder prevents overwrites and permits rollback of this batch alone.
    func importDocuments(from urls: [URL],
                         progress: @escaping @MainActor (String) -> Void = { _ in }) async throws -> [VaultDocument] {
        let root = rootURL
        // Start access before yielding; Files supplies these original security-scoped URLs.
        let sourceLeases = urls.map(DocumentSecurityScope.init)
        return try await performOperation { control in
            defer { withExtendedLifetime(sourceLeases) {} }
            let selected = Dictionary(grouping: urls, by: { $0.standardizedFileURL.resolvingSymlinksInPath().path })
                .values.compactMap(\.first).sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
            var documents: [VaultDocument] = []
            var batchFolder: URL?
            var completed = false
            defer {
                // Only this operation's new UUID folder can be removed, never an existing attachment.
                if !completed, let batchFolder { try? FileManager.default.removeItem(at: batchFolder) }
            }
            for (index, source) in selected.enumerated() {
                try control.checkCancellation()
                guard source.isFileURL, Self.supportedExtensions.contains(source.pathExtension.lowercased()) else {
                    throw DocumentLibraryError.unsupportedFile(source.lastPathComponent)
                }
                Self.report(String(localized: "正在准备 \(index + 1)/\(selected.count)：\(source.lastPathComponent) · 云端文件会自动下载"), control: control, progress: progress)
                if let relative = Self.relativePath(of: source, within: root) {
                    if BoardVideo.isVideo(path: relative) {
                        documents.append(try Self.document(at: source, relativePath: relative))
                        continue
                    }
                    let document = try Self.withReadableFile(source, control: control) { readable in
                        let handle = try FileHandle(forReadingFrom: readable)
                        defer { try? handle.close() }
                        _ = try handle.read(upToCount: 1)
                        return try Self.document(at: readable, relativePath: relative)
                    }
                    documents.append(document)
                } else {
                    if batchFolder == nil { batchFolder = try Self.makeImportFolder(root: root, control: control) }
                    guard let folder = batchFolder else { throw DocumentLibraryError.copyFailed }
                    let name = source.lastPathComponent.replacingOccurrences(of: "\\", with: "_")
                    var destination = folder.appendingPathComponent(name)
                    var suffix = 2
                    while FileManager.default.fileExists(atPath: destination.path) {
                        destination = folder.appendingPathComponent("\(suffix) \(name)")
                        suffix += 1
                    }
                    Self.report(String(localized: "正在复制到附件 \(index + 1)/\(selected.count)：\(source.lastPathComponent)"), control: control, progress: progress)
                    try Self.copyExternalFile(source, to: destination, root: root, control: control)
                    guard let relative = Self.relativePath(of: destination, within: root) else { throw DocumentLibraryError.outsideVault }
                    documents.append(try Self.document(at: destination, relativePath: relative))
                }
            }
            try control.checkCancellation()
            completed = true
            return Self.sortedUnique(documents)
        }
    }

    func makeReferenceItem(for document: VaultDocument, at point: CGPoint) -> BoardItem {
        BoardItem(kind: .document, x: Double(point.x), y: Double(point.y), width: 560, height: 360,
                  title: document.title, sourcePath: document.relativePath)
    }

    /// UI callers retain the publication until their board has accepted the items.
    /// Cancellation or validation failure before that point can remove only this
    /// operation's new, unchanged helper PDFs. Existing annotated PDFs are retained.
    func beginPublication() -> UUID {
        let id = UUID()
        pendingPublications.insert(id)
        return id
    }

    /// This cleanup intentionally runs even in a cancelled task. Once accepted,
    /// references already exist in memory and saving failure must not delete them.
    func finishPublication(_ id: UUID, accepted: Bool) async {
        guard pendingPublications.remove(id) != nil else { return }
        if accepted { await renderStore.commit(operationID: id) }
        else { await renderStore.rollback(operationID: id) }
    }

    /// Mixed insertion is one transaction: images become visible PDF pages;
    /// other documents remain original-source cards until explicitly expanded.
    func makeInsertionItems(documents: [VaultDocument], at point: CGPoint,
                            canvasSize: Double = PageGrid.worldSize,
                            publicationID: UUID? = nil) async throws -> [BoardItem] {
        if let publicationID, !pendingPublications.contains(publicationID) { throw DocumentLibraryError.invalidPublication }
        lastExpansionWarnings = []
        guard point.x.isFinite, point.y.isFinite, canvasSize.isFinite,
              canvasSize > 0, canvasSize <= PageGrid.worldSize,
              point.x >= 0, point.y >= 0, point.x <= canvasSize, point.y <= canvasSize else {
            throw DocumentExpansionError.insufficientSpace
        }
        let selected = try await prepareDocuments(documents, referenceOnly: true)
        let operationID = publicationID ?? UUID()
        do {
            var items: [BoardItem] = []
            var y = Double(point.y)
            for document in selected {
                try Task.checkCancellation()
                var item: BoardItem
                if document.isImage {
                    let source = try await renderStore.snapshot(relativePath: document.relativePath,
                        maximumBytes: ImageDocumentRenderer.maximumSourceBytes)
                    let data = try await ImageDocumentRenderer.render(data: source.data, fileExtension: document.fileExtension)
                    guard let pdf = PDFDocument(data: data), pdf.pageCount == 1,
                          let page = pdf.page(at: 0) else { throw ImageDocumentError.unreadable }
                    let bounds = page.bounds(for: .cropBox)
                    let height = 720 * Double(bounds.height / bounds.width)
                    guard height.isFinite, height > 0, Double(point.x) + 720 <= canvasSize,
                          y + height <= canvasSize else { throw DocumentExpansionError.insufficientSpace }
                    let path = try await renderStore.publish(pdfData: data, source: source,
                        rendererVersion: ImageDocumentRenderer.rendererVersion, operationID: operationID)
                    item = BoardItem(kind: .pdfPage, x: Double(point.x), y: y, width: 720, height: height,
                        title: document.title, sourcePath: path, originalSourcePath: source.relativePath,
                        originalSourceSHA256: source.sha256, page: 1)
                } else if Self.codeExtensions.contains(document.fileExtension) {
                    let source = try await renderStore.snapshot(relativePath: document.relativePath, maximumBytes: 2 * 1024 * 1024)
                    guard let text = String(data: source.data, encoding: .utf8) else { throw DocumentLibraryError.unsupportedFile(document.title) }
                    item = BoardItem(kind: .text, x: Double(point.x), y: y, width: 560, height: 360,
                        title: document.title, text: text,
                        textFormat: document.fileExtension == "tex" ? "latex" : document.fileExtension == "py" ? "python" : "plain",
                        sourcePath: document.relativePath)
                } else {
                    item = makeReferenceItem(for: document, at: CGPoint(x: point.x, y: y))
                }
                guard item.x + item.width <= canvasSize, item.y + item.height <= canvasSize else {
                    throw DocumentExpansionError.insufficientSpace
                }
                items.append(item); y += item.height + 48
            }
            try Task.checkCancellation()
            if publicationID == nil { await renderStore.commit(operationID: operationID) }
            return items
        } catch {
            await renderStore.rollback(operationID: operationID)
            throw error
        }
    }

    /// Page references only: no page-image pre-rendering or source duplication.
    func expandPDF(relativePath: String, at point: CGPoint,
                   options: DocumentExpansionOptions = .init()) async throws -> [BoardItem] {
        let document = VaultDocument(relativePath: relativePath, title: (relativePath as NSString).lastPathComponent,
                                     fileExtension: "pdf", byteCount: 0, requiresDownload: false)
        return try await expandDocuments([document], at: point, options: options)
    }

    /// Office conversion is explicit: expansion uses an existing sibling PDF.
    func expandOfficeViaSiblingPDF(relativePath: String, at point: CGPoint,
                                  options: DocumentExpansionOptions = .init()) async throws -> [BoardItem] {
        let root = rootURL
        let path = try await performOperation { control in
            try Self.siblingPDF(for: relativePath, root: root, control: control)
        }
        var items = try await expandPDF(relativePath: path, at: point, options: options)
        for index in items.indices { items[index].originalSourcePath = relativePath }
        return items
    }

    /// One complete batch, in stable source-path/page order. The chosen point is
    /// the first page's top-left corner; no cards are inserted or moved here.
    func prepareOfficeReadingPreview(sourceURL: URL,
                                     progress: @escaping @MainActor (String) -> Void = { _ in }) async throws -> (url: URL, warnings: [String]) {
        guard let relativePath = Self.relativePath(of: sourceURL, within: rootURL),
              Self.officeExtensions.contains(sourceURL.pathExtension.lowercased()),
              resolve(relativePath: relativePath) != nil else { throw DocumentLibraryError.outsideVault }
        let requested = VaultDocument(relativePath: relativePath, title: sourceURL.lastPathComponent,
                                      fileExtension: sourceURL.pathExtension.lowercased(), byteCount: 0, requiresDownload: false)
        let readable = try await prepareDocuments([requested], progress: progress)
        // Reuse source snapshot/version validation and immutable rendition
        // publication. The returned layout is never inserted into a board.
        let pages = try await expandDocuments(readable, at: .zero, progress: progress)
        try Task.checkCancellation()
        guard let path = pages.first?.sourcePath, let url = resolve(relativePath: path) else { throw DocumentLibraryError.noPages }
        return (url, lastExpansionWarnings)
    }

    func expandDocuments(_ documents: [VaultDocument], at point: CGPoint,
                         options: DocumentExpansionOptions = .init(),
                         canvasSize: Double = PageGrid.worldSize,
                         publicationID: UUID? = nil,
                         progress: @escaping @MainActor (String) -> Void = { _ in }) async throws -> [BoardItem] {
        if let publicationID, !pendingPublications.contains(publicationID) { throw DocumentLibraryError.invalidPublication }
        try options.validate()
        guard !documents.contains(where: { $0.isVideo }) else { throw BoardVideoError.cannotExpand }
        lastExpansionWarnings = []
        guard point.x.isFinite, point.y.isFinite,
              canvasSize.isFinite, canvasSize > 0, canvasSize <= PageGrid.worldSize,
              point.x >= 0, point.y >= 0, point.x <= canvasSize, point.y <= canvasSize else {
            throw DocumentExpansionError.insufficientSpace
        }
        let root = rootURL
        let selected = Self.sortedUnique(documents)
        let operationID = publicationID ?? UUID()
        do {
            var prepared: [(path: String, title: String, originalPath: String?, originalSHA: String?)] = []
            for (index, document) in selected.enumerated() {
                try Task.checkCancellation()
                progress(String(localized: "正在准备 \(index + 1)/\(selected.count)：\(document.title)"))
                if document.isPDF {
                    prepared.append((document.relativePath, document.title, nil, nil))
                } else {
                    let source = try await renderStore.snapshot(relativePath: document.relativePath,
                        maximumBytes: document.isMarkdown ? MarkdownDocumentService.maximumSourceBytes
                            : document.isImage ? ImageDocumentRenderer.maximumSourceBytes
                            : document.isExcel ? ExcelDocumentRenderer.maximumSourceBytes : 128 * 1_024 * 1_024)
                    let bytes: Data
                    let version: String
                    let dependencies: [String: String]
                    if document.isImage {
                        progress(String(localized: "正在添加图片：\(document.title)"))
                        bytes = try await ImageDocumentRenderer.render(data: source.data, fileExtension: document.fileExtension)
                        version = ImageDocumentRenderer.rendererVersion
                        dependencies = [:]
                    } else if document.isExcel {
                        progress(String(localized: "正在读取全部可见工作表：\(document.title)"))
                        let result = try await ExcelDocumentRenderer.render(data: source.data, fileExtension: document.fileExtension)
                        bytes = result.data
                        version = ExcelDocumentRenderer.rendererVersion
                        dependencies = [:]
                        lastExpansionWarnings.append(contentsOf: result.warnings.map { "\(document.title)：\($0)" })
                    } else if document.isMarkdown {
                        progress(String(localized: "正在排版 Markdown：\(document.title)"))
                        let snapshot = try MarkdownDocumentService.snapshot(data: source.data, relativePath: source.relativePath)
                        let result = try await markdown.renderPDF(snapshot: snapshot)
                        bytes = result.data
                        version = result.rendererVersion
                        dependencies = result.dependencyDigests
                        lastExpansionWarnings.append(contentsOf: result.warnings.map { "\(document.title)：\($0)" })
                    } else {
                        progress(String(localized: "正在生成阅读版：\(document.title) · 大文档需要更多时间"))
                        let temporary = try await renderStore.temporarySource(source)
                        do {
                            bytes = try await OfficeDocumentRenderer.render(sourceURL: temporary)
                            await renderStore.removeTemporarySource(temporary)
                        } catch {
                            await renderStore.removeTemporarySource(temporary)
                            throw error
                        }
                        version = "office-reading-1"
                        dependencies = [:]
                    }
                    try Task.checkCancellation()
                    progress(String(localized: "正在保存关联批注版：\(document.title)"))
                    let path = try await renderStore.publish(pdfData: bytes, source: source,
                        rendererVersion: version, dependencyDigests: dependencies, operationID: operationID)
                    prepared.append((path, document.title, source.relativePath, source.sha256))
                }
            }
            let sources = prepared
            let items = try await performOperation { control in
                guard point.x.isFinite, point.y.isFinite else { throw DocumentLibraryError.invalidGeometry }
                var pages: [DocumentPage] = []
                var seenPDFPaths: Set<String> = []
                for (index, document) in sources.enumerated() {
                    try control.checkCancellation()
                    Self.report(String(localized: "正在展开 \(index + 1)/\(sources.count)：\(document.title)"), control: control, progress: progress)
                    let path = document.path
                    guard seenPDFPaths.insert(path).inserted else { continue }
                    guard let url = VaultPathResolver.resolve(relativePath: path, within: root) else { throw DocumentLibraryError.missingFile }
                    let filePages = try Self.withReadableFile(url, control: control) { readable -> [DocumentPage] in
                        guard let pdf = PDFDocument(url: readable) else { throw DocumentLibraryError.unreadablePDF }
                        guard !pdf.isLocked else { throw DocumentLibraryError.lockedPDF }
                        guard pdf.pageCount > 0 else { throw DocumentLibraryError.noPages }
                        var result: [DocumentPage] = []
                        result.reserveCapacity(pdf.pageCount)
                        for pageIndex in 0..<pdf.pageCount {
                            try control.checkCancellation()
                            guard let page = pdf.page(at: pageIndex) else { throw DocumentLibraryError.invalidGeometry }
                            let bounds = page.bounds(for: .cropBox)
                            guard bounds.width > 0, bounds.height > 0, bounds.width.isFinite, bounds.height.isFinite else {
                                throw DocumentLibraryError.invalidGeometry
                            }
                            let rotation = ((page.rotation % 360) + 360) % 360
                            let size = rotation == 90 || rotation == 270 ? CGSize(width: bounds.height, height: bounds.width) : bounds.size
                            result.append(DocumentPage(sourcePath: path, originalSourcePath: document.originalPath,
                                originalSourceSHA256: document.originalSHA, title: document.title, page: pageIndex + 1, size: size))
                        }
                        return result
                    }
                    pages.append(contentsOf: filePages)
                }
                try control.checkCancellation()
                let frames = try PageGrid.expansionLayout(pageSizes: pages.map(\.size), at: point, options: options)
                guard frames.allSatisfy({ $0.maxX <= canvasSize && $0.maxY <= canvasSize }) else {
                    throw DocumentExpansionError.insufficientSpace
                }
                return zip(pages, frames).map { page, frame in
                    BoardItem(kind: .pdfPage, x: Double(frame.minX), y: Double(frame.minY),
                              width: Double(frame.width), height: Double(frame.height),
                              title: "\(page.title) · \(page.page)", sourcePath: page.sourcePath,
                              originalSourcePath: page.originalSourcePath, originalSourceSHA256: page.originalSourceSHA256, page: page.page)
                }
            }
            try Task.checkCancellation()
            if publicationID == nil { await renderStore.commit(operationID: operationID) }
            return items
        } catch {
            await renderStore.rollback(operationID: operationID)
            throw error
        }
    }

    private func performOperation<Value>(_ work: @escaping (DocumentOperationControl) throws -> Value) async throws -> Value {
        let control = DocumentOperationControl()
        let lease = scope
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                operationsQueue.async {
                    defer { withExtendedLifetime(lease) {} }
                    let result = Result { try control.checkCancellation(); return try autoreleasepool { try work(control) } }
                    control.finishReporting()
                    continuation.resume(with: result)
                }
            }
        } onCancel: { control.cancel() }
    }

    private nonisolated static func report(_ message: String, control: DocumentOperationControl,
                                           progress: @escaping @MainActor (String) -> Void) {
        Task { @MainActor in
            guard control.canReport else { return }
            progress(message)
        }
    }

    nonisolated static func sortedUnique(_ documents: [VaultDocument]) -> [VaultDocument] {
        Dictionary(grouping: documents, by: \.relativePath).values.compactMap(\.first)
            .sorted { $0.relativePath.localizedStandardCompare($1.relativePath) == .orderedAscending }
    }

    private nonisolated static func relativePath(of url: URL, within root: URL) -> String? {
        let rootParts = root.standardizedFileURL.resolvingSymlinksInPath().pathComponents
        let file = url.standardizedFileURL.resolvingSymlinksInPath()
        guard file.pathComponents.count > rootParts.count,
              Array(file.pathComponents.prefix(rootParts.count)) == rootParts else { return nil }
        let relative = file.pathComponents.dropFirst(rootParts.count).joined(separator: "/")
        guard let checked = VaultPathResolver.resolve(relativePath: relative, within: root),
              checked.pathComponents == file.pathComponents else { return nil }
        return relative
    }

    private nonisolated static func document(at url: URL, relativePath: String) throws -> VaultDocument {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw DocumentLibraryError.missingFile }
        let ext = url.pathExtension.lowercased()
        guard supportedExtensions.contains(ext) else { throw DocumentLibraryError.unsupportedFile(url.lastPathComponent) }
        return VaultDocument(relativePath: relativePath, title: (relativePath as NSString).lastPathComponent,
                             fileExtension: ext, byteCount: Int64(values.fileSize ?? 0), requiresDownload: false)
    }

    private nonisolated static func beginCloudDownload(_ url: URL, control: DocumentOperationControl) throws {
        try control.checkCancellation()
        let values = try url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .isSymbolicLinkKey])
        guard values.isSymbolicLink != true else { throw DocumentLibraryError.outsideVault }
        if values.isUbiquitousItem == true && values.ubiquitousItemDownloadingStatus == .notDownloaded {
            try FileManager.default.startDownloadingUbiquitousItem(at: url)
        }
        try control.checkCancellation()
    }

    private nonisolated static func withReadableFile<Value>(_ url: URL, control: DocumentOperationControl,
                                                            read: (URL) throws -> Value) throws -> Value {
        try beginCloudDownload(url, control: control)
        let coordinator = NSFileCoordinator()
        try control.use(coordinator)
        defer { control.clearCoordinator() }
        var error: NSError?
        var result: Result<Value, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &error) { readable in
            result = Result { try control.checkCancellation(); return try read(readable) }
        }
        try control.checkCancellation()
        if let error { throw error }
        guard let result else { throw DocumentLibraryError.missingFile }
        return try result.get()
    }

    private nonisolated static func siblingPDF(for path: String, root: URL, control: DocumentOperationControl) throws -> String {
        guard let source = VaultPathResolver.resolve(relativePath: path, within: root) else { throw DocumentLibraryError.missingFile }
        let expectedName = source.deletingPathExtension().lastPathComponent + ".pdf"
        let coordinator = NSFileCoordinator()
        try control.use(coordinator)
        defer { control.clearCoordinator() }
        var error: NSError?
        var found: String?
        var readError: Error?
        coordinator.coordinate(readingItemAt: source.deletingLastPathComponent(), options: [], error: &error) { folder in
            do {
                try control.checkCancellation()
                let siblings = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isSymbolicLinkKey])
                if let sibling = siblings.first(where: { $0.lastPathComponent.caseInsensitiveCompare(expectedName) == .orderedSame }),
                   try sibling.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true {
                    found = relativePath(of: sibling, within: root)
                }
            } catch { readError = error }
        }
        try control.checkCancellation()
        if let error { throw error }
        if let readError { throw readError }
        guard let found else { throw DocumentLibraryError.missingConvertedPDF(expectedName) }
        return found
    }

    private nonisolated static func makeImportFolder(root: URL, control: DocumentOperationControl) throws -> URL {
        let coordinator = NSFileCoordinator()
        try control.use(coordinator)
        defer { control.clearCoordinator() }
        var error: NSError?
        var result: Result<URL, Error>?
        coordinator.coordinate(writingItemAt: root, options: [], error: &error) { writableRoot in
            result = Result {
                try control.checkCancellation()
                guard writableRoot.standardizedFileURL.resolvingSymlinksInPath().pathComponents == root.pathComponents else {
                    throw DocumentLibraryError.outsideVault
                }
                var folder = writableRoot
                let batchName = UUID().uuidString
                for component in ["Attachments", "InkSpace", batchName] {
                    try control.checkCancellation()
                    folder.appendPathComponent(component, isDirectory: true)
                    if FileManager.default.fileExists(atPath: folder.path) {
                        guard component != batchName else { throw DocumentLibraryError.copyFailed }
                        let values = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                        guard values.isDirectory == true, values.isSymbolicLink != true else { throw DocumentLibraryError.unsafeAttachmentFolder }
                    } else {
                        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
                    }
                    guard let safe = relativePath(of: folder, within: root), !safe.isEmpty else { throw DocumentLibraryError.outsideVault }
                }
                return folder
            }
        }
        try control.checkCancellation()
        if let error { throw error }
        guard let result else { throw DocumentLibraryError.copyFailed }
        return try result.get()
    }

    private nonisolated static func copyExternalFile(_ source: URL, to destination: URL, root: URL, control: DocumentOperationControl) throws {
        try beginCloudDownload(source, control: control)
        let coordinator = NSFileCoordinator()
        try control.use(coordinator)
        defer { control.clearCoordinator() }
        var error: NSError?
        var copyError: Error?
        coordinator.coordinate(readingItemAt: source, options: [], writingItemAt: destination, options: [], error: &error) { readable, writable in
            do {
                try control.checkCancellation()
                guard Self.relativePath(of: writable.deletingLastPathComponent(), within: root) != nil,
                      writable.standardizedFileURL.resolvingSymlinksInPath().pathComponents == destination.standardizedFileURL.resolvingSymlinksInPath().pathComponents else {
                    throw DocumentLibraryError.outsideVault
                }
                let values = try readable.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true else { throw DocumentLibraryError.missingFile }
                guard !FileManager.default.fileExists(atPath: writable.path),
                      FileManager.default.createFile(atPath: writable.path, contents: nil) else { throw DocumentLibraryError.copyFailed }
                let input = try FileHandle(forReadingFrom: readable)
                defer { try? input.close() }
                let output = try FileHandle(forWritingTo: writable)
                defer { try? output.close() }
                while true {
                    try control.checkCancellation()
                    guard let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty else { break }
                    try output.write(contentsOf: chunk)
                }
                try output.synchronize()
                try control.checkCancellation()
            } catch { copyError = error }
        }
        try control.checkCancellation()
        if let error { throw error }
        if let copyError { throw copyError }
    }

    /// Viewport previews bypass the legacy image caches. The compositor owns the
    /// only bitmap cache and receives local completion, without board observation.
    func viewportThumbnail(item: BoardItem, pixelLength: Int, token: BoardPreviewCancellation,
                           region: BoardPDFTileRegion? = nil, completion: @escaping (Result<BoardPreviewImage, Error>) -> Void) {
        let generation = cacheGeneration
        BoardViewportThumbnailWorker.shared.image(item: item, root: rootURL, owners: annotationOwnersToHide,
            pixelLength: pixelLength, token: token, region: region) { [weak self, scope] result in
                _ = scope // Retain the original authorized URL lease through background work.
                guard let self, self.cacheGeneration == generation else {
                    completion(.failure(DocumentLibraryError.cancelled)); return
                }
                completion(result)
            }
    }

    func viewportSourceRevisions(paths: Set<String>, token: BoardPreviewCancellation,
                                 completion: @escaping ([String: String]) -> Void) {
        let generation = cacheGeneration
        BoardViewportThumbnailWorker.shared.revisions(root: rootURL, paths: paths, token: token) { [weak self, scope] values in
            _ = scope
            guard self?.cacheGeneration == generation else { return }
            completion(values)
        }
    }

    /// Call for visible/nearby cards only. Results are memory-cached with a strict cost budget.
    /// Completion always returns on the main actor, including cache hits and errors.
    func thumbnail(item: BoardItem, completion: @escaping (Result<UIImage, Error>) -> Void) {
        if BoardVideo.isVideo(item) {
            if let image = UIImage(systemName: "play.rectangle.fill") { completion(.success(image)) }
            else { completion(.failure(DocumentLibraryError.thumbnailUnavailable)) }
            return // Static icon only; never load or thumbnail video implicitly.
        }
        guard let path = item.sourcePath, let url = resolve(relativePath: path) else {
            completion(.failure(DocumentLibraryError.missingFile)); return
        }
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let revision = "\(path)|\(values?.contentModificationDate?.timeIntervalSince1970 ?? 0)|\(values?.fileSize ?? 0)|owners:\(BoardPDFAnnotationOwners.cacheKey(annotationOwnersToHide))"
        let page = max(1, item.page ?? 1)
        let key = "\(revision)|\(page)"
        if let image = images.object(forKey: key as NSString) {
            imageLRU.removeAll { $0 == key }
            imageLRU.append(key)
            completion(.success(image)); return
        }
        if pending[key] != nil { pending[key]?.append(completion); return }
        pending[key] = [completion]
        let generation = cacheGeneration
        if url.pathExtension.lowercased() == "pdf" {
            worker.image(url: url, revision: revision, pageNumber: page,
                         size: CGSize(width: 900, height: 1_200), scope: scope, annotationOwners: annotationOwnersToHide) { [weak self] result in
                Task { @MainActor in self?.finishThumbnail(result, key: key, generation: generation) }
            }
        } else {
            let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 640, height: 480),
                                                       scale: 1, representationTypes: .thumbnail)
            quickLookRequests[key] = request
            QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self, scope] representation, error in
                _ = scope
                let result: Result<UIImage, Error> = representation.map { .success($0.uiImage) }
                    ?? .failure(error ?? DocumentLibraryError.thumbnailUnavailable)
                Task { @MainActor in self?.finishThumbnail(result, key: key, generation: generation) }
            }
        }
    }

    private func finishThumbnail(_ result: Result<UIImage, Error>, key: String, generation: Int) {
        guard cacheGeneration == generation else { return }
        if case .success(let image) = result {
            let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? Int(image.size.width * image.size.height * 4)
            imageLRU.removeAll { $0 == key }
            imageCosts.removeValue(forKey: key)
            // NSCache limits are advisory, so also evict explicitly before every insertion.
            while !imageLRU.isEmpty && (imageLRU.count >= 32 || imageCosts.values.reduce(0, +) + cost > imageBudget) {
                let oldest = imageLRU.removeFirst()
                images.removeObject(forKey: oldest as NSString)
                imageCosts.removeValue(forKey: oldest)
            }
            if cost <= imageBudget {
                images.setObject(image, forKey: key as NSString, cost: cost)
                imageCosts[key] = cost
                imageLRU.append(key)
            }
        }
        quickLookRequests.removeValue(forKey: key)
        let callbacks = pending.removeValue(forKey: key) ?? []
        callbacks.forEach { $0(result) }
    }

    func clearCache() {
        cacheGeneration += 1
        images.removeAllObjects()
        imageCosts.removeAll()
        imageLRU.removeAll()
        worker.clearCache()
        BoardViewportThumbnailWorker.shared.clearCache()
        quickLookRequests.values.forEach { QLThumbnailGenerator.shared.cancel($0) }
        quickLookRequests.removeAll()
        let callbacks = pending.values.flatMap { $0 }
        pending.removeAll()
        callbacks.forEach { $0(.failure(DocumentLibraryError.cancelled)) }
    }
}
