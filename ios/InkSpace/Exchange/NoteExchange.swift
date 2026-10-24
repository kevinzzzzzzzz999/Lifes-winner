import Foundation
import CoreGraphics
import ImageIO
import AudioToolbox
import Darwin

/// Interchange is an explicit copy operation. Private notebook formats are opaque
/// archives; this module never unzips or interprets them as editable InkSpace data.
enum NoteExchangeKind: String, Sendable { case readable, archive }
struct NoteExchangeItemResult: Identifiable, Sendable {
    let id = UUID()
    let sourceName: String
    let destination: URL?
    let kind: NoteExchangeKind?
    let error: String?
}
struct NoteExchangeBatchResult: Sendable {
    let items: [NoteExchangeItemResult]
    let cancelled: Bool
}
enum NoteExchangeError: LocalizedError {
    case invalidFolder, unsupported, compressed, notRegular, tooLarge, changed, capacity, tooMany, invalidContent
    var errorDescription: String? {
        switch self {
        case .invalidFolder: String(localized: "保存文件夹不可用或超出授权范围。请重新选择课程文件夹。")
        case .unsupported: String(localized: "此格式暂不支持交换。请在来源应用导出 PDF、图片或文本。")
        case .compressed: String(localized: "请先在“文件”中解压 ZIP，再选择其中的 PDF、图片或音频。录音与笔迹的时间对应关系不会恢复。")
        case .notRegular: String(localized: "请选择普通文件；文件夹、别名和链接不能作为笔记导入。")
        case .tooLarge: String(localized: "单个交换文件最多 256 MiB，请拆分后再导入。")
        case .changed: String(localized: "复制时原文件发生变化，请等来源应用保存完后重试。")
        case .capacity: String(localized: "本次导入最多 1 GiB，已完成的文件保留，请分批继续。")
        case .tooMany: String(localized: "每次最多选择 100 个文件。")
        case .invalidContent: String(localized: "文件为空、内容损坏、加密或与格式不符，未导入。请从来源应用重新导出。")
        }
    }
}
enum NoteExchange {
    static let readableExtensions: Set<String> = ["pdf", "png", "jpg", "jpeg", "md", "markdown", "txt", "m4a", "mp3", "wav", "aac", "aiff", "caf"]
    static let archiveExtensions: Set<String> = ["goodnotes", "note", "nbn", "boardnotes", "one", "onepkg", "onetoc2"]
    static let maximumFileBytes = 256 * 1024 * 1024
    static let maximumBatchBytes = 1024 * 1024 * 1024
    static func kind(for url: URL) throws -> NoteExchangeKind {
        let ext = url.pathExtension.lowercased()
        if ext == "zip" { throw NoteExchangeError.compressed }
        if readableExtensions.contains(ext) { return .readable }
        if archiveExtensions.contains(ext) { return .archive }
        throw NoteExchangeError.unsupported
    }
    static func targetDirectory(root: URL, path: String) throws -> URL {
        guard root.isFileURL, !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0"),
              path.isEmpty || path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw NoteExchangeError.invalidFolder }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        let target = path.isEmpty ? base : base.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        let rootParts = base.pathComponents
        guard target.pathComponents.starts(with: rootParts),
              (try target.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true else { throw NoteExchangeError.invalidFolder }
        return target
    }
    /// Runs off the main actor. Cancelling preserves committed files and removes
    /// only this operation's incomplete temporary copy.
    static func importFiles(_ sources: [URL], root: URL, directory: String,
                            progress: @escaping @Sendable (Int, Int) async -> Void = { _, _ in }) async throws -> NoteExchangeBatchResult {
        guard sources.count <= 100 else { throw NoteExchangeError.tooMany }
        let worker = Task.detached(priority: .userInitiated) {
            let scope = root.startAccessingSecurityScopedResource()
            defer { if scope { root.stopAccessingSecurityScopedResource() } }
            _ = try targetDirectory(root: root, path: directory)
            var results: [NoteExchangeItemResult] = [], total = 0
            for source in sources {
                if Task.isCancelled { return NoteExchangeBatchResult(items: results, cancelled: true) }
                do {
                    let kind = try kind(for: source)
                    let (url, bytes) = try copy(source, root: root, directory: directory, remaining: maximumBatchBytes - total)
                    total += bytes
                    results.append(.init(sourceName: source.lastPathComponent, destination: url, kind: kind, error: nil))
                } catch is CancellationError {
                    return NoteExchangeBatchResult(items: results, cancelled: true)
                } catch {
                    results.append(.init(sourceName: source.lastPathComponent, destination: nil, kind: nil, error: error.localizedDescription))
                }
                await progress(results.count, sources.count)
            }
            return NoteExchangeBatchResult(items: results, cancelled: false)
        }
        return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
    }
    private static func validateReadableCopy(_ url: URL, originalExtension ext: String) throws {
        guard readableExtensions.contains(ext) else { return }
        let bytes = ((try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0)
        guard bytes > 0 else { throw NoteExchangeError.invalidContent }
        if ext == "pdf" {
            guard let pdf = CGPDFDocument(url as CFURL), !pdf.isEncrypted, pdf.numberOfPages > 0, pdf.numberOfPages <= 100_000 else { throw NoteExchangeError.invalidContent }
        } else if ["png", "jpg", "jpeg"].contains(ext) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0,
                  let type = CGImageSourceGetType(source) as String?, ["public.png", "public.jpeg"].contains(type),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                  width.doubleValue > 0, height.doubleValue > 0,
                  width.doubleValue * height.doubleValue <= 80_000_000,
                  CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 32] as CFDictionary) != nil else { throw NoteExchangeError.invalidContent }
        } else if ["md", "markdown", "txt"].contains(ext) {
            guard bytes <= 16 * 1024 * 1024, let text = String(data: try Data(contentsOf: url), encoding: .utf8), !text.contains("\0") else { throw NoteExchangeError.invalidContent }
        } else {
            var audio: AudioFileID?
            guard AudioFileOpenURL(url as CFURL, .readPermission, 0, &audio) == noErr, let audio else { throw NoteExchangeError.invalidContent }
            AudioFileClose(audio)
        }
    }
    private static func copy(_ source: URL, root: URL, directory: String, remaining: Int) throws -> (URL, Int) {
        guard source.isFileURL else { throw NoteExchangeError.notRegular }
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpace-Exchange-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        var coordinationError: NSError?
        var readResult: Result<Int, Error> = .failure(NoteExchangeError.notRegular)
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinationError) { readable in
            readResult = Result {
                try Task.checkCancellation()
                let before = try readable.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey, .fileResourceIdentifierKey])
                guard before.isRegularFile == true, before.isSymbolicLink != true else { throw NoteExchangeError.notRegular }
                let size = before.fileSize ?? maximumFileBytes + 1
                guard size <= maximumFileBytes else { throw NoteExchangeError.tooLarge }
                guard size <= remaining else { throw NoteExchangeError.capacity }
                guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
                let input = try FileHandle(forReadingFrom: readable), output = try FileHandle(forWritingTo: temporary)
                var initialStat = stat()
                guard fstat(input.fileDescriptor, &initialStat) == 0 else { throw NoteExchangeError.changed }
                defer { try? input.close(); try? output.close() }
                var count = 0
                while let data = try input.read(upToCount: 1_048_576), !data.isEmpty {
                    try Task.checkCancellation()
                    count += data.count
                    guard count <= maximumFileBytes else { throw NoteExchangeError.tooLarge }
                    guard count <= remaining else { throw NoteExchangeError.capacity }
                    try output.write(contentsOf: data)
                }
                try output.synchronize()
                let after = try readable.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .fileResourceIdentifierKey])
                let sameID = (before.fileResourceIdentifier == nil && after.fileResourceIdentifier == nil) || ((before.fileResourceIdentifier as? NSObject)?.isEqual(after.fileResourceIdentifier) ?? false)
                var finalStat = stat(), pathStat = stat()
                guard fstat(input.fileDescriptor, &finalStat) == 0, lstat(readable.path, &pathStat) == 0,
                      initialStat.st_ino == finalStat.st_ino, initialStat.st_dev == finalStat.st_dev,
                      initialStat.st_ino == pathStat.st_ino, initialStat.st_dev == pathStat.st_dev,
                      initialStat.st_mtimespec.tv_sec == finalStat.st_mtimespec.tv_sec,
                      initialStat.st_mtimespec.tv_nsec == finalStat.st_mtimespec.tv_nsec else { throw NoteExchangeError.changed }
                guard count == size, after.fileSize == before.fileSize, after.contentModificationDate == before.contentModificationDate, sameID else { throw NoteExchangeError.changed }
                try Task.checkCancellation()
                return count
            }
        }
        if let coordinationError { throw coordinationError }
        let count = try readResult.get()
        try validateReadableCopy(temporary, originalExtension: source.pathExtension.lowercased())
        try Task.checkCancellation()
        let stagedFolder = try targetDirectory(root: root, path: directory)
        let staged = stagedFolder.appendingPathComponent(".inkspace-exchange-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: staged) }
        try FileManager.default.copyItem(at: temporary, to: staged)
        var stem = source.deletingPathExtension().lastPathComponent
        stem = stem.components(separatedBy: CharacterSet(charactersIn: "/\\:\0\n\r")).joined(separator: "-")
        while stem.utf8.count > 150 { stem.removeLast() }
        if stem.isEmpty || stem.hasPrefix(".") { stem = "Imported note" }
        let ext = source.pathExtension.lowercased()
        for suffix in 1...1000 {
            try Task.checkCancellation()
            let folder = try targetDirectory(root: root, path: directory)
            let destination = folder.appendingPathComponent(stem + (suffix == 1 ? "" : " (\(suffix))") + "." + ext)
            if FileManager.default.fileExists(atPath: destination.path) { continue }
            var writeError: NSError?
            var result: Result<Void, Error> = .failure(NoteExchangeError.invalidFolder)
            NSFileCoordinator().coordinate(writingItemAt: destination, options: [], error: &writeError) { writable in
                result = Result {
                    try Task.checkCancellation()
                    let checked = try targetDirectory(root: root, path: directory)
                    guard checked == folder, writable.standardizedFileURL == destination.standardizedFileURL,
                          writable.deletingLastPathComponent().resolvingSymlinksInPath() == folder else { throw NoteExchangeError.invalidFolder }
                    // copyItem is create-only; an interleaving same-name writer wins
                    // and we retry the next number. Existing data is never removed.
                    guard folder == stagedFolder else { throw NoteExchangeError.invalidFolder }
                    try FileManager.default.moveItem(at: staged, to: writable)
                }
            }
            if let writeError { throw writeError }
            do { try result.get(); return (destination, count) }
            catch { if (error as NSError).code == NSFileWriteFileExistsError { continue }; throw error }
        }
        throw CocoaError(.fileWriteFileExists)
    }
}
