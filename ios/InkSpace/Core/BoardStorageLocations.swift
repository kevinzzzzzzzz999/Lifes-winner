import Foundation

struct BoardFileListing: Sendable {
    let files: [URL]
    let warning: String?
}

enum BoardStorageError: LocalizedError {
    case invalidDirectory, missingDirectory
    var errorDescription: String? {
        switch self {
        case .invalidDirectory: String(localized: "保存位置必须是仓库内的普通文件夹。")
        case .missingDirectory: String(localized: "保存文件夹已移动或暂不可用，请重新选择保存位置。")
        }
    }
}

/// Folder metadata work stays off the main actor. Empty path denotes the vault root.
/// Only the historical default InkSpace folder may be created automatically.
enum BoardStorageLocations {
    static func directory(root: URL, relativePath: String, createDefault: Bool = false) throws -> URL {
        guard root.isFileURL, relativePath.isEmpty || VaultPath.isSafeRelative(relativePath) else {
            throw BoardStorageError.invalidDirectory
        }
        let root = root.standardizedFileURL.resolvingSymlinksInPath()
        guard try root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw BoardStorageError.missingDirectory
        }
        if createDefault && relativePath == "InkSpace" {
            let target = root.appendingPathComponent("InkSpace", isDirectory: true)
            if !FileManager.default.fileExists(atPath: target.path) {
                let coordinator = NSFileCoordinator()
                var error: NSError?
                var result: Result<Void, Error> = .failure(BoardStorageError.missingDirectory)
                coordinator.coordinate(writingItemAt: target, options: [], error: &error) { coordinated in
                    result = Result {
                        // A concurrent creator must not substitute a symbolic link.
                        if !FileManager.default.fileExists(atPath: coordinated.path) {
                            try FileManager.default.createDirectory(at: coordinated, withIntermediateDirectories: false)
                        }
                    }
                }
                if let error { throw error }
                try result.get()
            }
        }
        var current = root
        for part in relativePath.split(separator: "/") {
            current.appendPathComponent(String(part), isDirectory: true)
            let values = try current.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey])
            guard values.isDirectory == true, values.isSymbolicLink != true,
                  values.isHidden != true, values.isPackage != true else { throw BoardStorageError.invalidDirectory }
        }
        return current
    }

    static func prepareDirectory(root: URL, relativePath: String, createDefault: Bool = false) async throws -> URL {
        let task = Task.detached(priority: .userInitiated) {
            let access = root.startAccessingSecurityScopedResource()
            defer { if access { root.stopAccessingSecurityScopedResource() } }
            try Task.checkCancellation()
            return try directory(root: root, relativePath: relativePath, createDefault: createDefault)
        }
        return try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
    }

    static func discover(root: URL) async -> BoardFileListing {
        let task = Task.detached(priority: .userInitiated) {
            let access = root.startAccessingSecurityScopedResource()
            defer { if access { root.stopAccessingSecurityScopedResource() } }
            do { return try scan(root: root) }
            catch is CancellationError { return BoardFileListing(files: [], warning: nil) }
            catch { return BoardFileListing(files: [], warning: String(localized: "无法读取白板目录：\(error.localizedDescription)")) }
        }
        return await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
    }

    static func scan(root: URL) throws -> BoardFileListing {
        let root = try directory(root: root, relativePath: "")
        let coordinator = NSFileCoordinator()
        var error: NSError?
        var result: Result<BoardFileListing, Error> = .failure(BoardStorageError.missingDirectory)
        coordinator.coordinate(readingItemAt: root, options: .withoutChanges, error: &error) { coordinatedRoot in
            result = Result {
                try Task.checkCancellation()
                let keys: Set<URLResourceKey> = [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .isHiddenKey, .isPackageKey]
                var warning: String?
                guard let enumerator = FileManager.default.enumerator(at: coordinatedRoot,
                    includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles, .skipsPackageDescendants],
                    errorHandler: { _, error in warning = String(localized: "部分文件夹暂不可读取：\(error.localizedDescription)"); return true }) else {
                    throw BoardStorageError.missingDirectory
                }
                var files: [URL] = []
                for case let url as URL in enumerator {
                    try Task.checkCancellation()
                    do {
                        let values = try url.resourceValues(forKeys: keys)
                        if values.isSymbolicLink == true || values.isHidden == true || values.isPackage == true {
                            if values.isDirectory == true { enumerator.skipDescendants() }
                            continue
                        }
                        guard values.isRegularFile == true, url.lastPathComponent.hasSuffix(".inkspace.json") else { continue }
                        let candidate = url.standardizedFileURL
                        let base = coordinatedRoot.standardizedFileURL.path + "/"
                        guard candidate.path.hasPrefix(base) else { continue }
                        let relative = String(candidate.path.dropFirst(base.count))
                        guard VaultPath.isSafeRelative(relative) else { continue }
                        files.append(root.appendingPathComponent(relative))
                    } catch { warning = String(localized: "部分文件暂不可读取：\(error.localizedDescription)") }
                }
                return BoardFileListing(files: files.sorted {
                    $0.path.localizedStandardCompare($1.path) == .orderedAscending
                }, warning: warning)
            }
        }
        if let error { throw error }
        return try result.get()
    }
}
