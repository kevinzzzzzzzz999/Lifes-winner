import Foundation
import CryptoKit

struct CourseChecklistSnapshot: Sendable {
    let path: String
    let document: CourseChecklistDocument
    let fingerprint: String
}

/// All checklist writes are coordinated, compare the bytes actually read, and keep private local backups.
actor CourseChecklistStore {
    nonisolated let rootURL: URL
    private let backupURL: URL
    init(rootURL: URL, backupURL: URL? = nil) {
        self.rootURL = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        self.backupURL = backupURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("InkSpace/CourseChecklistBackups", isDirectory: true)
    }
    static func fingerprint(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func checklistPath(directory: String) -> String { directory.isEmpty ? "课程清单.inkcheck.json" : directory + "/课程清单.inkcheck.json" }
    /// Merely browsing a week is not an explicit storage choice. File links retain their original path.
    static func initialLocation(contextDirectory _: String, explicitFilePath: String? = nil) -> (directory: String, path: String) {
        let path = explicitFilePath ?? checklistPath(directory: "")
        let directory = path.split(separator: "/", omittingEmptySubsequences: false).dropLast().joined(separator: "/")
        return (directory, path)
    }
    private func checkedURL(_ path: String, directory: Bool = false) throws -> URL {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard (path.isEmpty && directory) || (!path.isEmpty && !path.contains("\\") && !path.contains("\0") && parts.allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") })) else { throw CourseChecklistError.path }
        var result = rootURL
        let rootValues = try rootURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else { throw CourseChecklistError.path }
        if !path.isEmpty {
            for (index, part) in parts.enumerated() {
                result.appendPathComponent(String(part))
                if let attributes = try? FileManager.default.attributesOfItem(atPath: result.path), attributes[.type] as? FileAttributeType == .typeSymbolicLink { throw CourseChecklistError.path }
                var isDirectory: ObjCBool = false
                if FileManager.default.fileExists(atPath: result.path, isDirectory: &isDirectory) {
                    let values = try result.resourceValues(forKeys: [.isSymbolicLinkKey, .isPackageKey])
                    guard values.isSymbolicLink != true, values.isPackage != true,
                          (index == parts.count - 1 && !directory) || isDirectory.boolValue,
                          result.standardizedFileURL.resolvingSymlinksInPath().path == result.path else { throw CourseChecklistError.path }
                } else if index != parts.count - 1 || directory { throw CourseChecklistError.path }
            }
        }
        if !directory {
            guard path.lowercased().hasSuffix(".inkcheck.json") else { throw CourseChecklistError.path }
            if FileManager.default.fileExists(atPath: result.path) {
                let values = try result.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true else { throw CourseChecklistError.path }
            }
        }
        return result
    }
    private func withAccess<T>(_ work: () throws -> T) rethrows -> T {
        let scoped = rootURL.startAccessingSecurityScopedResource()
        defer { if scoped { rootURL.stopAccessingSecurityScopedResource() } }
        return try work()
    }
    private func boundedRead(_ url: URL) throws -> Data {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= CourseChecklistDocument.maximumBytes else { throw CourseChecklistError.tooLarge }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: CourseChecklistDocument.maximumBytes + 1) ?? Data()
        guard data.count <= CourseChecklistDocument.maximumBytes else { throw CourseChecklistError.tooLarge }
        return data
    }
    func load(path: String) throws -> CourseChecklistSnapshot? {
        try withAccess {
            let url = try checkedURL(path)
            let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
            if values?.isUbiquitousItem == true, values?.ubiquitousItemDownloadingStatus == .notDownloaded {
                try FileManager.default.startDownloadingUbiquitousItem(at: url)
            }
            var coordinationError: NSError?
            var result: Result<CourseChecklistSnapshot?, Error>?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinated in
                result = Result {
                    _ = try checkedURL(path)
                    // Only a genuinely absent file is an empty state; other errors remain errors.
                    let data: Data
                    do { data = try boundedRead(coordinated) }
                    catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
                    let document = try CourseChecklistDocument.decode(data)
                    return CourseChecklistSnapshot(path: path, document: document, fingerprint: Self.fingerprint(data))
                }
            }
            if let coordinationError {
                if coordinationError.domain == NSCocoaErrorDomain && coordinationError.code == NSFileReadNoSuchFileError,
                   !FileManager.default.fileExists(atPath: url.path) { return nil }
                throw coordinationError
            }
            guard let result else { throw CourseChecklistError.missing }
            return try result.get()
        }
    }
    func folders(in path: String) throws -> [String] {
        try withAccess {
            let directory = try checkedURL(path, directory: true)
            return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isPackageKey], options: [.skipsHiddenFiles])
                .prefix(5000).filter { url in
                    guard let value = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .isPackageKey]) else { return false }
                    return value.isDirectory == true && value.isSymbolicLink != true && value.isPackage != true
                }.map { path.isEmpty ? $0.lastPathComponent : path + "/" + $0.lastPathComponent }
                .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        }
    }
    func create(path: String, title: String) throws -> CourseChecklistSnapshot {
        guard !path.contains("/") else { throw CourseChecklistError.rootOnly }
        return try save(document: CourseChecklistDocument.create(title: title), path: path, expected: nil)
    }
    func change(_ snapshot: CourseChecklistSnapshot, _ change: CourseChecklistDocument.Change, poems: [CoursePoem]) throws -> CourseChecklistSnapshot {
        try save(document: snapshot.document.applying(change, poems: poems), path: snapshot.path, expected: snapshot.fingerprint)
    }
    private func save(document: CourseChecklistDocument, path: String, expected: String?) throws -> CourseChecklistSnapshot {
        try withAccess {
            let url = try checkedURL(path)
            var coordinationError: NSError?
            var result: Result<CourseChecklistSnapshot, Error>?
            NSFileCoordinator().coordinate(writingItemAt: url, options: expected == nil ? [] : .forReplacing, error: &coordinationError) { coordinated in
                result = Result {
                    _ = try checkedURL(path)
                    try Task.checkCancellation()
                    let exists = FileManager.default.fileExists(atPath: coordinated.path)
                    if exists {
                        let current = try boundedRead(coordinated)
                        guard let expected, Self.fingerprint(current) == expected else { throw CourseChecklistError.conflict }
                        try backup(current, path: path)
                    } else if expected != nil { throw CourseChecklistError.conflict }
                    // The new state is backed up too, including first creation, before claiming success.
                    try backup(document.data, path: path)
                    try document.data.write(to: coordinated, options: .atomic)
                    return CourseChecklistSnapshot(path: path, document: document, fingerprint: Self.fingerprint(document.data))
                }
            }
            if let coordinationError { throw coordinationError }
            guard let result else { throw CourseChecklistError.missing }
            return try result.get()
        }
    }
    private func backup(_ data: Data, path: String) throws {
        do {
            let key = Self.fingerprint(Data((rootURL.path + "/" + path).utf8))
            var directory = backupURL.appendingPathComponent(key, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            let target = directory.appendingPathComponent(Self.fingerprint(data) + ".json")
            if !FileManager.default.fileExists(atPath: target.path) { try data.write(to: target, options: .atomic) }
            let backups = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])
                .filter { $0.pathExtension == "json" }.sorted {
                    ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
                }
            for old in backups.dropFirst(30) where old != target { try? FileManager.default.removeItem(at: old) }
        } catch { throw CourseChecklistError.backup }
    }
}
