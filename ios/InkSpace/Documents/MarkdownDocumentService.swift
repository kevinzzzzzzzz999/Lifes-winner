import Foundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

struct MarkdownDocumentSnapshot: Sendable {
    let relativePath: String
    let text: String
    let sourceSHA256: String
    let originalBytes: Data
    let hasUTF8BOM: Bool
    let preferredNewline: String

    /// No parser round-trip: frontmatter, comments and unsupported syntax remain source text.
    func bytes(replacingText text: String) throws -> Data {
        if text == self.text { return originalBytes }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let encoded = normalized.replacingOccurrences(of: "\n", with: preferredNewline)
        var data = hasUTF8BOM ? Data([0xEF, 0xBB, 0xBF]) : Data()
        data.append(contentsOf: encoded.utf8)
        guard data.count <= MarkdownDocumentService.maximumSourceBytes else { throw MarkdownDocumentError.tooLarge }
        return data
    }
}

struct MarkdownPDFResult: Sendable {
    let data: Data
    let pageCount: Int
    let dependencyDigests: [String: String]
    let rendererVersion: String
    let warnings: [String]
}

enum MarkdownDocumentError: LocalizedError {
    case unsafePath, unavailable, unsupportedEncoding, tooLarge, externalChange
    case resourcesMissing, renderingFailed, timedOut, tooManyPages

    var errorDescription: String? {
        switch self {
        case .unsafePath: String(localized: "文件位置超出了已授权的仓库，或包含不支持的链接。")
        case .unavailable: String(localized: "原文暂不可用，请确认文件已下载且仍在已授权的仓库内。")
        case .unsupportedEncoding: String(localized: "此 Markdown 不是有效 UTF-8 文本。请先在原编辑器转换编码，原文件未改动。")
        case .tooLarge: String(localized: "此 Markdown 或图片超过处理容量，请拆分文档或缩小图片后重试。")
        case .externalChange: String(localized: "原文已被其他应用或设备修改。未覆盖外部修改；你的编辑仍保留在当前窗口，可复制后再关闭。")
        case .resourcesMissing: String(localized: "Markdown 离线排版资源缺失，请重新安装完整应用。")
        case .renderingFailed: String(localized: "暂时无法完成 Markdown 排版，原文和已有白板均已保留。")
        case .timedOut: String(localized: "Markdown 排版超时，请缩短文档或减少图片后重试。")
        case .tooManyPages: String(localized: "排版超过 2000 页，请将文档拆分后展开。")
        }
    }
}

struct MarkdownReference: Sendable {
    let key: String
    let href: String
    let isImage: Bool
    let isWiki: Bool
}

struct MarkdownAssets: Sendable {
    var images: [String: String] = [:]
    var links: [String: String] = [:]
    var dependencyDigests: [String: String] = [:]
    var warnings: [String] = []
}

/// All source writes compare the coordinated latest bytes. PDF generation only returns
/// bytes; publishing a derived annotation PDF belongs to SourceDocumentRenderStore.
@MainActor
final class MarkdownDocumentService {
    nonisolated static let maximumSourceBytes = 2 * 1_024 * 1_024
    nonisolated static var rendererVersion: String { DocumentReadingLanguage.version("markdown-a4-v1-marked17.0.5-katex0.18.7") }
    private let files: MarkdownFileAccess
    private let bundle: Bundle

    init(rootURL: URL, bundle: Bundle = .main) {
        files = MarkdownFileAccess(rootURL: rootURL)
        self.bundle = bundle
    }

    nonisolated static func snapshot(data: Data, relativePath: String) throws -> MarkdownDocumentSnapshot {
        guard MarkdownFileAccess.isSafeSourcePath(relativePath) else { throw MarkdownDocumentError.unsafePath }
        guard data.count <= maximumSourceBytes else { throw MarkdownDocumentError.tooLarge }
        let bom = data.starts(with: [0xEF, 0xBB, 0xBF])
        let payload = bom ? data.dropFirst(3) : data[...]
        guard let raw = String(data: payload, encoding: .utf8), !raw.contains("\0") else {
            throw MarkdownDocumentError.unsupportedEncoding
        }
        let crlf = raw.components(separatedBy: "\r\n").count - 1
        let lf = raw.components(separatedBy: "\n").count - 1
        let cr = raw.components(separatedBy: "\r").count - 1
        let newline = crlf > 0 && crlf >= lf - crlf ? "\r\n" : (cr > 0 && lf == 0 ? "\r" : "\n")
        return MarkdownDocumentSnapshot(relativePath: relativePath,
                                        text: raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n"),
                                        sourceSHA256: MarkdownFileAccess.digest(data), originalBytes: data,
                                        hasUTF8BOM: bom, preferredNewline: newline)
    }

    func load(relativePath: String) async throws -> MarkdownDocumentSnapshot {
        let data = try await files.readSource(relativePath)
        return try Self.snapshot(data: data, relativePath: relativePath)
    }

    func save(text: String, basedOn snapshot: MarkdownDocumentSnapshot) async throws -> MarkdownDocumentSnapshot {
        let data = try snapshot.bytes(replacingText: text)
        try await files.writeSource(data, basedOn: snapshot)
        return try Self.snapshot(data: data, relativePath: snapshot.relativePath)
    }

    func renderPDF(snapshot: MarkdownDocumentSnapshot) async throws -> MarkdownPDFResult {
        // A fresh web view isolates cancelled jobs and simultaneous reader/converter calls.
        let renderer = MarkdownDocumentRenderer(bundle: bundle)
        return try await renderer.render(snapshot: snapshot) { [files] references in
            try await files.assets(for: references, sourcePath: snapshot.relativePath)
        }
    }
}

private final class MarkdownCoordinationControl: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var coordinator: NSFileCoordinator?
    func install(_ value: NSFileCoordinator) throws {
        lock.lock(); let cancelled = stopped; if !cancelled { coordinator = value }; lock.unlock()
        if cancelled { value.cancel(); throw CancellationError() }
    }
    func check() throws {
        lock.lock(); let cancelled = stopped; lock.unlock()
        if cancelled { throw CancellationError() }
    }
    func cancel() { lock.lock(); stopped = true; let value = coordinator; lock.unlock(); value?.cancel() }
    func clear() { lock.lock(); coordinator = nil; lock.unlock() }
}

private actor MarkdownFileAccess {
    private let authorizedURL: URL
    private let root: URL
    private let scope: Bool
    private let imageLimit = 8 * 1_024 * 1_024
    private let totalImageLimit = 32 * 1_024 * 1_024

    init(rootURL: URL) {
        authorizedURL = rootURL
        scope = rootURL.startAccessingSecurityScopedResource()
        root = rootURL.standardizedFileURL.resolvingSymlinksInPath()
    }
    deinit { if scope { authorizedURL.stopAccessingSecurityScopedResource() } }

    nonisolated static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    nonisolated static func isSafeSourcePath(_ path: String) -> Bool {
        safeRelative(path) && ["md", "markdown"].contains((path as NSString).pathExtension.lowercased())
    }
    nonisolated private static func safeRelative(_ path: String) -> Bool {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains(":"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    func readSource(_ path: String) async throws -> Data {
        guard Self.isSafeSourcePath(path) else { throw MarkdownDocumentError.unsafePath }
        return try await coordinatedRead(path, limit: MarkdownDocumentService.maximumSourceBytes)
    }

    func writeSource(_ data: Data, basedOn snapshot: MarkdownDocumentSnapshot) async throws {
        guard Self.isSafeSourcePath(snapshot.relativePath), data.count <= MarkdownDocumentService.maximumSourceBytes else {
            throw MarkdownDocumentError.unsafePath
        }
        let control = MarkdownCoordinationControl()
        try await withTaskCancellationHandler {
            try control.check()
            let source = try checkedFile(snapshot.relativePath)
            let coordinator = NSFileCoordinator()
            try control.install(coordinator)
            defer { control.clear() }
            var error: NSError?
            var result: Result<Void, Error>?
            coordinator.coordinate(writingItemAt: source, options: .forReplacing, error: &error) { target in
                result = Result {
                    try control.check()
                    guard try checkedFile(snapshot.relativePath).pathComponents == target.standardizedFileURL.pathComponents else {
                        throw MarkdownDocumentError.unsafePath
                    }
                    let current = try boundedRead(target, limit: MarkdownDocumentService.maximumSourceBytes, control: control)
                    guard Self.digest(current) == snapshot.sourceSHA256 else { throw MarkdownDocumentError.externalChange }
                    if current == data { return }
                    try control.check()
                    try data.write(to: target, options: .atomic)
                }
            }
            if let error { throw error }
            guard let result else { throw MarkdownDocumentError.unavailable }
            try result.get()
            // Do not report cancellation after an already committed atomic save.
        } onCancel: { control.cancel() }
    }

    private func coordinatedRead(_ path: String, limit: Int) async throws -> Data {
        let control = MarkdownCoordinationControl()
        return try await withTaskCancellationHandler {
            let source = try checkedFile(path)
            let values = try source.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
            if values.isUbiquitousItem == true && values.ubiquitousItemDownloadingStatus == .notDownloaded {
                try FileManager.default.startDownloadingUbiquitousItem(at: source)
            }
            let coordinator = NSFileCoordinator()
            try control.install(coordinator)
            defer { control.clear() }
            var error: NSError?
            var result: Result<Data, Error>?
            coordinator.coordinate(readingItemAt: source, options: [], error: &error) { target in
                result = Result {
                    try control.check()
                    guard try checkedFile(path).pathComponents == target.standardizedFileURL.pathComponents else {
                        throw MarkdownDocumentError.unsafePath
                    }
                    return try boundedRead(target, limit: limit, control: control)
                }
            }
            try control.check()
            if let error { throw error }
            guard let result else { throw MarkdownDocumentError.unavailable }
            return try result.get()
        } onCancel: { control.cancel() }
    }

    private func checkedFile(_ path: String) throws -> URL {
        guard Self.safeRelative(path), root.isFileURL else { throw MarkdownDocumentError.unsafePath }
        var cursor = root
        for component in path.split(separator: "/") {
            cursor.appendPathComponent(String(component))
            let values = try cursor.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw MarkdownDocumentError.unsafePath }
        }
        guard cursor.standardizedFileURL.resolvingSymlinksInPath().pathComponents == cursor.pathComponents,
              try cursor.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
            throw MarkdownDocumentError.unavailable
        }
        return cursor
    }

    private func boundedRead(_ url: URL, limit: Int, control: MarkdownCoordinationControl) throws -> Data {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw MarkdownDocumentError.unsafePath }
        guard (values.fileSize ?? Int.max) <= limit else { throw MarkdownDocumentError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var data = Data()
        while let part = try handle.read(upToCount: min(256 * 1_024, limit + 1)), !part.isEmpty {
            try control.check()
            guard part.count <= limit - data.count else { throw MarkdownDocumentError.tooLarge }
            data.append(part)
        }
        return data
    }

    func assets(for references: [MarkdownReference], sourcePath: String) async throws -> MarkdownAssets {
        guard references.count <= 4_096 else { throw MarkdownDocumentError.tooLarge }
        var result = MarkdownAssets()
        var imageBytes = 0
        var imageCount = 0
        var encodedImageBytes = 0
        var imageCache: [String: String] = [:]
        for reference in references {
            try Task.checkCancellation()
            if reference.isImage {
                imageCount += 1
                guard imageCount <= 128 else { throw MarkdownDocumentError.tooLarge }
            }
            if !reference.isImage, let url = URL(string: reference.href),
               ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                result.links[reference.key] = url.absoluteString
                continue
            }
            guard let path = normalizedReference(reference.href, sourcePath: sourcePath, isWiki: reference.isWiki) else {
                if reference.isImage { result.warnings.append(String(localized: "未自动加载外部或不安全的图片：\(reference.href.prefix(100))")) }
                continue
            }
            if !reference.isImage {
                var link = URLComponents()
                link.scheme = "obsidian"; link.host = "open"
                // Link activation is explicit; Obsidian resolves extensionless wikilinks.
                let decoded = reference.href.removingPercentEncoding ?? reference.href
                let fragment = decoded.firstIndex(of: "#").map { String(decoded[$0...]) } ?? ""
                link.queryItems = [URLQueryItem(name: "vault", value: authorizedURL.lastPathComponent),
                                   URLQueryItem(name: "file", value: path + fragment)]
                result.links[reference.key] = link.url?.absoluteString
                continue
            }
            if let image = imageCache[path] {
                guard image.utf8.count <= totalImageLimit - encodedImageBytes else { throw MarkdownDocumentError.tooLarge }
                encodedImageBytes += image.utf8.count
                result.images[reference.key] = image
                continue
            }
            do {
                guard ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp"].contains((path as NSString).pathExtension.lowercased()) else {
                    throw MarkdownDocumentError.unavailable
                }
                let data = try await coordinatedRead(path, limit: imageLimit)
                guard data.count <= totalImageLimit - imageBytes else { throw MarkdownDocumentError.tooLarge }
                imageBytes += data.count
                guard let image = CGImageSourceCreateWithData(data as CFData, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                      let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                      width.doubleValue > 0, height.doubleValue > 0,
                      width.doubleValue * height.doubleValue <= 40_000_000,
                      let thumbnail = CGImageSourceCreateThumbnailAtIndex(image, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 1_600
                      ] as CFDictionary) else { throw MarkdownDocumentError.tooLarge }
                let encoded = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(encoded, UTType.png.identifier as CFString, 1, nil) else {
                    throw MarkdownDocumentError.renderingFailed
                }
                CGImageDestinationAddImage(destination, thumbnail, nil)
                guard CGImageDestinationFinalize(destination) else { throw MarkdownDocumentError.renderingFailed }
                let uri = "data:image/png;base64," + (encoded as Data).base64EncodedString()
                guard uri.utf8.count <= totalImageLimit - encodedImageBytes else { throw MarkdownDocumentError.tooLarge }
                encodedImageBytes += uri.utf8.count
                imageCache[path] = uri; result.images[reference.key] = uri
                result.dependencyDigests[path] = Self.digest(data)
            } catch is CancellationError { throw CancellationError() }
            catch {
                result.warnings.append(String(localized: "图片未显示：\(path)（\(error.localizedDescription)）"))
            }
        }
        return result
    }

    /// Markdown links are relative to their note; wiki paths are relative to vault root.
    /// Lexical ../ is legal only while it remains inside that root. Symlinks are checked on read.
    private func normalizedReference(_ href: String, sourcePath: String, isWiki: Bool) -> String? {
        guard let decoded = href.removingPercentEncoding, !decoded.contains("\\"), !decoded.contains(":"),
              !decoded.contains("?"), !decoded.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        let withoutFragment = String(decoded.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        if withoutFragment.isEmpty { return sourcePath }
        var components = isWiki || withoutFragment.hasPrefix("/") ? [] : Array(sourcePath.split(separator: "/").dropLast()).map(String.init)
        for component in withoutFragment.split(separator: "/", omittingEmptySubsequences: true) {
            if component == "." { continue }
            if component == ".." {
                guard !components.isEmpty else { return nil }
                components.removeLast()
            } else { components.append(String(component)) }
        }
        let path = components.joined(separator: "/")
        return Self.safeRelative(path) ? path : nil
    }
}
