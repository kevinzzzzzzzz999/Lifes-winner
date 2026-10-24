import Foundation

/// Copies only externally selected media into a new, owned vault attachment batch.
/// Existing vault sources are referenced in place. Original files are never changed.
@MainActor enum MediaSourceImporter {
    static let extensions: Set<String> = ["mp4", "mov", "m4v", "mp3", "m4a", "wav", "aif", "aiff", "caf"]

    static func load(_ urls: [URL], root: URL, videosOnly: Bool = false, progress: @escaping (String) -> Void) async throws -> [MediaSource] {
        guard !urls.isEmpty, urls.count <= 200,
              urls.allSatisfy({ $0.isFileURL && extensions.contains($0.pathExtension.lowercased()) }) else { throw MediaEditError.unsupported }
        let rootAccess = root.startAccessingSecurityScopedResource()
        let accesses = urls.map { $0.startAccessingSecurityScopedResource() }
        var batch: URL?
        var accepted = false
        defer {
            for (url, active) in zip(urls, accesses) where active { url.stopAccessingSecurityScopedResource() }
            if rootAccess { root.stopAccessingSecurityScopedResource() }
            if !accepted, let batch { try? FileManager.default.removeItem(at: batch) }
        }
        var results: [MediaSource] = []
        for (index, original) in urls.enumerated() {
            try Task.checkCancellation()
            progress(mediaText("正在导入素材", "Importing media") + " \(index + 1)/\(urls.count) · " + original.lastPathComponent)
            let source: URL
            let path: String
            if let relative = relativePath(original, root: root) {
                guard let resolved = VaultPathResolver.resolve(relativePath: relative, within: root) else { throw MediaEditError.sourceChanged(original.lastPathComponent) }
                source = resolved; path = relative
            } else {
                if batch == nil { batch = try await Task.detached(priority: .userInitiated) { try makeBatch(root: root) }.value }
                guard let batch else { throw VaultWriteError.unavailable }
                source = batch.appendingPathComponent("\(index + 1)-" + safeFilename(original.lastPathComponent))
                try await Task.detached(priority: .userInitiated) {
                    var coordination: NSError?, failure: Error?
                    NSFileCoordinator().coordinate(readingItemAt: original, options: [], writingItemAt: source, options: [], error: &coordination) { readable, writable in
                        do { try FileManager.default.copyItem(at: readable, to: writable) } catch { failure = error }
                    }
                    if let coordination { throw coordination }; if let failure { throw failure }
                }.value
                guard let relative = relativePath(source, root: root) else { throw MediaEditError.invalidProject }
                path = relative
            }
            var value = try await MediaExportService.probe(url: source, relativePath: path)
            guard !videosOnly || value.hasVideo else { throw MediaEditError.audioRequiresMac }
            value.name = original.lastPathComponent
            try Task.checkCancellation()
            results.append(value)
        }
        accepted = true
        return results
    }

    nonisolated static func relativePath(_ url: URL, root: URL) -> String? {
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        guard path.hasPrefix(base) else { return nil }
        let relative = String(path.dropFirst(base.count))
        return VaultPath.isSafeRelative(relative) ? relative : nil
    }
    nonisolated static func safeFilename(_ original: String) -> String {
        let ext = (original as NSString).pathExtension.lowercased()
        var stem = ((original as NSString).lastPathComponent as NSString).deletingPathExtension
            .replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: ":", with: "_")
        stem = String(stem.filter { !$0.isNewline && $0 != "\0" })
        while stem.utf8.count > 160 { stem.removeLast() }
        if stem.isEmpty || stem.hasPrefix(".") { stem = "Media-" + String(UUID().uuidString.prefix(8)) }
        return stem + "." + ext
    }
    nonisolated private static func makeBatch(root: URL) throws -> URL {
        var directory = try BoardStorageLocations.directory(root: root, relativePath: "")
        for component in ["Attachments", "InkSpace", "Media", UUID().uuidString] {
            directory.appendPathComponent(component, isDirectory: true)
            let coordinator = NSFileCoordinator()
            var coordination: NSError?, failure: Error?
            coordinator.coordinate(writingItemAt: directory, options: [], error: &coordination) { target in
                do {
                    if !FileManager.default.fileExists(atPath: target.path) { try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false) }
                    let values = try target.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard values.isDirectory == true, values.isSymbolicLink != true else { throw BoardStorageError.invalidDirectory }
                } catch { failure = error }
            }
            if let coordination { throw coordination }; if let failure { throw failure }
        }
        return directory
    }
}

func mediaText(_ chinese: String, _ english: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("zh") == true ? chinese : english
}
func mediaTime(_ seconds: Double) -> String {
    guard seconds.isFinite else { return "—" }
    let value = max(0, seconds)
    return String(format: "%02d:%05.2f", Int(value) / 60, value.truncatingRemainder(dividingBy: 60))
}
