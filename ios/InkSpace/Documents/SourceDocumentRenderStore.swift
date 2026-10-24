import Foundation
import CryptoKit
import PDFKit

struct SourceDocumentSnapshot: Sendable {
    let relativePath: String
    let data: Data
    let sha256: String
}

enum SourceDocumentRenderError: LocalizedError {
    case unavailable, unsafePath, sourceChanged, tooLarge, invalidPDF, destinationUnavailable

    var errorDescription: String? {
        switch self {
        case .unavailable: String(localized: "原文暂不可用，请检查 iCloud 下载状态后重试。")
        case .unsafePath: String(localized: "原文或批注版的位置不在已授权的文件夹内。")
        case .sourceChanged: String(localized: "转换期间原文发生了修改。请重新展开，已有白板和原文均已保留。")
        case .tooLarge: String(localized: "此文档超过本次转换的处理容量，请分成较小的文档后重试。")
        case .invalidPDF: String(localized: "未能生成完整、可阅读的页面。原文和已有白板已保留。")
        case .destinationUnavailable: String(localized: "无法保存关联的批注版，请检查文件夹权限和剩余空间。")
        }
    }
}

private final class RenderCoordinationControl: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var coordinator: NSFileCoordinator?
    func install(_ value: NSFileCoordinator) throws {
        lock.lock()
        let stopped = cancelled
        if !stopped { coordinator = value }
        lock.unlock()
        if stopped { value.cancel(); throw CancellationError() }
    }
    func check() throws {
        lock.lock(); let stopped = cancelled; lock.unlock()
        if stopped { throw CancellationError() }
    }
    func cancel() {
        lock.lock(); cancelled = true; let current = coordinator; lock.unlock()
        current?.cancel()
    }
    func clear() { lock.lock(); coordinator = nil; lock.unlock() }
}

/// Office/Markdown originals never become PDF writeback targets. Every rendered
/// revision has its own PDF; a changed source cannot move old ink onto new text.
actor SourceDocumentRenderStore {
    private let rootURL: URL
    private let authorizedURL: URL
    private let acquiredScope: Bool
    private let sourceLimit = 128 * 1_024 * 1_024
    private let renderedLimit = 128 * 1_024 * 1_024
    private var pendingPublications: [UUID: [(path: String, sha256: String)]] = [:]

    init(rootURL: URL) {
        authorizedURL = rootURL
        acquiredScope = rootURL.startAccessingSecurityScopedResource()
        self.rootURL = rootURL.standardizedFileURL.resolvingSymlinksInPath()
    }

    deinit { if acquiredScope { authorizedURL.stopAccessingSecurityScopedResource() } }

    func snapshot(relativePath: String, maximumBytes: Int = 128 * 1_024 * 1_024) async throws -> SourceDocumentSnapshot {
        let control = RenderCoordinationControl()
        return try await withTaskCancellationHandler {
            guard maximumBytes > 0, maximumBytes <= sourceLimit else { throw SourceDocumentRenderError.tooLarge }
            let original = try checkedFile(relativePath)
            let cloud = try original.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
            if cloud.isUbiquitousItem == true && cloud.ubiquitousItemDownloadingStatus == .notDownloaded {
                try FileManager.default.startDownloadingUbiquitousItem(at: original)
            }
            let coordinator = NSFileCoordinator()
            try control.install(coordinator)
            defer { control.clear() }
            var coordinationError: NSError?
            var result: Result<SourceDocumentSnapshot, Error>?
            coordinator.coordinate(readingItemAt: original, options: [], error: &coordinationError) { readable in
                result = Result {
                    try control.check()
                    guard try checkedFile(relativePath).pathComponents == readable.standardizedFileURL.pathComponents else {
                        throw SourceDocumentRenderError.unsafePath
                    }
                    let bytes = try readBounded(readable, limit: maximumBytes, control: control)
                    return SourceDocumentSnapshot(relativePath: relativePath, data: bytes, sha256: Self.digest(bytes))
                }
            }
            try control.check()
            if let coordinationError { throw coordinationError }
            guard let result else { throw SourceDocumentRenderError.unavailable }
            return try result.get()
        } onCancel: { control.cancel() }
    }

    /// Reuses a matching annotated PDF without rewriting it. New PDFs are placed
    /// alongside the source, with a revision key and embedded provenance instead
    /// of an extra manifest file. No pre-existing destination is overwritten.
    func publish(pdfData: Data, source: SourceDocumentSnapshot, rendererVersion: String,
                 dependencyDigests: [String: String] = [:], operationID: UUID? = nil) async throws -> String {
        let control = RenderCoordinationControl()
        return try await withTaskCancellationHandler {
            try control.check()
            // An image edited while Markdown was rendering belongs to a newer
            // reading version. Verify dependencies separately before publishing;
            // iCloud does not offer a transaction across these source files.
            for (path, expected) in dependencyDigests.sorted(by: { $0.key < $1.key }) {
                try control.check()
                let imageURL = try checkedFile(path)
                let reader = NSFileCoordinator()
                try control.install(reader)
                var readError: NSError?
                var verification: Result<Void, Error>?
                reader.coordinate(readingItemAt: imageURL, options: [], error: &readError) { readable in
                    verification = Result {
                        guard try checkedFile(path).pathComponents == readable.standardizedFileURL.pathComponents,
                              Self.digest(try readBounded(readable, limit: 8 * 1_024 * 1_024, control: control)) == expected else {
                            throw SourceDocumentRenderError.sourceChanged
                        }
                    }
                }
                control.clear()
                if let readError { throw readError }
                guard let verification else { throw SourceDocumentRenderError.unavailable }
                try verification.get()
            }
            guard !pdfData.isEmpty, pdfData.count <= renderedLimit,
                  let pdf = PDFDocument(data: pdfData), !pdf.isLocked, !pdf.isEncrypted,
                  pdf.pageCount > 0, pdf.pageCount <= 10_000 else { throw SourceDocumentRenderError.invalidPDF }
            for index in 0..<pdf.pageCount {
                try control.check()
                guard let page = pdf.page(at: index) else { throw SourceDocumentRenderError.invalidPDF }
                let box = page.bounds(for: .cropBox)
                guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0 else {
                    throw SourceDocumentRenderError.invalidPDF
                }
            }
            let identity: [String: Any] = ["source": source.relativePath, "sha256": source.sha256,
                                           "renderer": rendererVersion, "dependencies": dependencyDigests]
            let identityData = try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys])
            let key = Self.digest(identityData)
            let marker = "InkSpace rendered document v1\n" + String(decoding: identityData, as: UTF8.self)
            var attributes = pdf.documentAttributes ?? [:]
            attributes[PDFDocumentAttribute.creatorAttribute] = "人生赢家"
            attributes[PDFDocumentAttribute.subjectAttribute] = marker
            pdf.documentAttributes = attributes
            guard let output = pdf.dataRepresentation(), output.count <= renderedLimit,
                  let verified = PDFDocument(data: output), verified.pageCount == pdf.pageCount,
                  verified.documentAttributes?[PDFDocumentAttribute.subjectAttribute] as? String == marker else {
                throw SourceDocumentRenderError.invalidPDF
            }
            let original = try checkedFile(source.relativePath)
            let parent = original.deletingLastPathComponent()
            var stem = original.lastPathComponent
            while stem.utf8.count > 120 { stem.removeLast() }
            for index in 1...32 {
                try control.check()
                let suffix = index == 1 ? "" : "-\(index)"
                let name = "\(stem) · 批注-\(key.prefix(12))\(suffix).pdf"
                let destination = parent.appendingPathComponent(name)
                let parentPath = (source.relativePath as NSString).deletingLastPathComponent
                let path = parentPath.isEmpty ? name : parentPath + "/" + name
                let coordinator = NSFileCoordinator()
                try control.install(coordinator)
                var coordinationError: NSError?
                var result: Result<Bool, Error>?
                var created = false
                coordinator.coordinate(readingItemAt: original, options: [], writingItemAt: destination,
                                       options: [], error: &coordinationError) { readable, writable in
                    result = Result {
                        try control.check()
                        guard try checkedFile(source.relativePath).pathComponents == readable.standardizedFileURL.pathComponents,
                              parent.standardizedFileURL.resolvingSymlinksInPath().pathComponents == parent.pathComponents,
                              writable.standardizedFileURL.resolvingSymlinksInPath().pathComponents == destination.pathComponents,
                              VaultPath.isSafeRelative(path) else { throw SourceDocumentRenderError.unsafePath }
                        let current = try readBounded(readable, limit: sourceLimit, control: control)
                        guard Self.digest(current) == source.sha256 else { throw SourceDocumentRenderError.sourceChanged }
                        if FileManager.default.fileExists(atPath: writable.path) {
                            let values = try writable.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey])
                            guard values.isSymbolicLink != true, values.isRegularFile == true,
                                  (values.fileSize ?? Int.max) <= 256 * 1_024 * 1_024 else { return false }
                            let bytes = try readBounded(writable, limit: 256 * 1_024 * 1_024, control: control)
                            guard let existing = PDFDocument(data: bytes), !existing.isLocked,
                                  existing.pageCount == verified.pageCount,
                                  existing.documentAttributes?[PDFDocumentAttribute.subjectAttribute] as? String == marker else { return false }
                            return true
                        }
                        try control.check()
                        let temporary = parent.appendingPathComponent(".inkspace-render-\(UUID().uuidString).tmp")
                        defer { try? FileManager.default.removeItem(at: temporary) }
                        try output.write(to: temporary, options: .withoutOverwriting)
                        try control.check()
                        // Same-directory move publishes the complete file. moveItem
                        // refuses an existing destination; no source is replaced.
                        try FileManager.default.moveItem(at: temporary, to: writable)
                        created = true
                        return true
                    }
                }
                control.clear()
                if created, let operationID {
                    pendingPublications[operationID, default: []].append((path, Self.digest(output)))
                }
                try control.check()
                if let coordinationError { throw coordinationError }
                guard let result else { throw SourceDocumentRenderError.destinationUnavailable }
                if try result.get() { return path }
            }
            throw SourceDocumentRenderError.destinationUnavailable
        } onCancel: { control.cancel() }
    }

    func commit(operationID: UUID) { pendingPublications.removeValue(forKey: operationID) }

    /// Only newly produced and still byte-identical files can be rolled back.
    /// A reused file or one edited by another application is never removed.
    func rollback(operationID: UUID) {
        let files = pendingPublications.removeValue(forKey: operationID) ?? []
        for file in files {
            guard let url = try? checkedFile(file.path) else { continue }
            let control = RenderCoordinationControl()
            let coordinator = NSFileCoordinator()
            var error: NSError?
            coordinator.coordinate(writingItemAt: url, options: .forDeleting, error: &error) { target in
                guard let checked = try? checkedFile(file.path),
                      checked.pathComponents == target.standardizedFileURL.pathComponents,
                      let current = try? readBounded(target, limit: renderedLimit, control: control),
                      Self.digest(current) == file.sha256 else { return }
                try? FileManager.default.removeItem(at: target)
            }
        }
    }

    func temporarySource(_ source: SourceDocumentSnapshot) throws -> URL {
        try Task.checkCancellation()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpaceOffice-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let url = directory.appendingPathComponent((source.relativePath as NSString).lastPathComponent)
        do {
            try source.data.write(to: url, options: .withoutOverwriting)
            try Task.checkCancellation()
            return url
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    func removeTemporarySource(_ url: URL) {
        let directory = url.deletingLastPathComponent()
        guard directory.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL,
              directory.lastPathComponent.hasPrefix("InkSpaceOffice-") else { return }
        try? FileManager.default.removeItem(at: directory)
    }

    private func checkedFile(_ path: String) throws -> URL {
        guard VaultPath.isSafeRelative(path) else { throw SourceDocumentRenderError.unsafePath }
        var cursor = rootURL
        for component in path.split(separator: "/") {
            cursor.appendPathComponent(String(component))
            let values = try cursor.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw SourceDocumentRenderError.unsafePath }
        }
        guard let resolved = VaultPathResolver.resolve(relativePath: path, within: rootURL),
              resolved.pathComponents == cursor.standardizedFileURL.pathComponents,
              try resolved.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
            throw SourceDocumentRenderError.unavailable
        }
        return resolved
    }

    private func readBounded(_ url: URL, limit: Int, control: RenderCoordinationControl) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw SourceDocumentRenderError.unsafePath }
        guard (values.fileSize ?? Int.max) <= limit else { throw SourceDocumentRenderError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var bytes = Data()
        while true {
            try control.check()
            guard let part = try handle.read(upToCount: 1_024 * 1_024), !part.isEmpty else { break }
            guard bytes.count <= limit - part.count else { throw SourceDocumentRenderError.tooLarge }
            bytes.append(part)
        }
        return bytes
    }

    private nonisolated static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
