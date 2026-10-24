import Foundation
import Observation

enum RecentBrowseKind: String, Codable, Sendable {
    case folder, board, document

    var displayName: String {
        switch self {
        case .folder: String(localized: "文件夹")
        case .board: String(localized: "白板")
        case .document: String(localized: "文件")
        }
    }

    var systemImage: String {
        switch self {
        case .folder: "folder"
        case .board: "rectangle.and.pencil.and.ellipsis"
        case .document: "doc.text"
        }
    }
}

/// App-private navigation metadata only. It never contains a document's contents.
struct RecentBrowseEntry: Identifiable, Codable, Equatable, Sendable {
    let id: UUID
    let kind: RecentBrowseKind
    let title: String
    let rootDisplayName: String
    let rootDisplayPath: String
    let relativePath: String
    let lastOpenedAt: Date
    let rootBookmark: Data
    fileprivate let canonicalRootPath: String
    fileprivate let rootFileIdentity: String?

    var displayPath: String {
        relativePath.isEmpty ? rootDisplayPath : (rootDisplayPath as NSString).appendingPathComponent(relativePath)
    }

    fileprivate var identity: String {
        kind.rawValue + "\u{0}" + canonicalRootPath + "\u{0}" + (rootFileIdentity ?? "") + "\u{0}" + relativePath
    }
}

enum RecentBrowseError: LocalizedError {
    case invalidPath, unavailableRoot, invalidStorage, newerStorage

    var errorDescription: String? {
        switch self {
        case .invalidPath: String(localized: "这条最近浏览记录不在所选文件夹内。")
        case .unavailableRoot: String(localized: "文件夹暂不可访问，请重新选择它所在的位置授权。最近记录已保留。")
        case .invalidStorage: String(localized: "最近浏览记录暂不可读取，原记录已保留；文件和白板不受影响。")
        case .newerStorage: String(localized: "最近浏览记录由较新版本创建，原记录已保留。请更新应用后重试。")
        }
    }
}

private struct RecentBrowseSnapshot: Codable {
    var schemaVersion = 1
    var entries: [RecentBrowseEntry] = []

    func validate() throws {
        guard schemaVersion == 1 else { throw RecentBrowseError.newerStorage }
        guard entries.count <= RecentBrowseStore.maximumEntries,
              Set(entries.map(\.id)).count == entries.count,
              Set(entries.map(\.identity)).count == entries.count else { throw RecentBrowseError.invalidStorage }
        for entry in entries {
            guard RecentBrowseStore.isSafeRelativePath(entry.relativePath, kind: entry.kind),
                  entry.canonicalRootPath.hasPrefix("/"), !entry.canonicalRootPath.contains("\u{0}"),
                  !entry.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  entry.title.utf8.count <= 16_384,
                  !entry.rootDisplayName.isEmpty, !entry.rootDisplayPath.isEmpty,
                  !entry.rootBookmark.isEmpty, entry.rootBookmark.count <= 1_048_576,
                  entry.rootFileIdentity.map({ !$0.isEmpty && $0.utf8.count <= 128 }) ?? true,
                  entry.lastOpenedAt.timeIntervalSinceReferenceDate.isFinite else {
                throw RecentBrowseError.invalidStorage
            }
        }
    }
}

/// Every scene uses `shared`. Main-actor serialization orders opens across windows;
/// each coordinated transaction rereads disk so another instance cannot drop entries.
/// No method reads, creates, renames, or deletes a document in a user's vault.
@MainActor @Observable
final class RecentBrowseStore {
    static let shared = RecentBrowseStore()
    nonisolated static let maximumEntries = 50

    private(set) var entries: [RecentBrowseEntry] = []
    private(set) var storageIssue: String?
    @ObservationIgnored private let storageURL: URL
    @ObservationIgnored private let maximumBytes = 8 * 1_024 * 1_024

    init(storageURL: URL? = nil) {
        self.storageURL = storageURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("RecentBrowse", isDirectory: true).appendingPathComponent("recent-v1.json")
        reload()
    }

    /// Empty is valid only for the root folder. No traversal or absolute targets.
    nonisolated static func isSafeRelativePath(_ path: String, kind: RecentBrowseKind) -> Bool {
        if path.isEmpty { return kind == .folder }
        guard !path.hasPrefix("/"), !path.hasPrefix("~"), !path.contains("\u{0}"),
              !path.contains("\\"), path.utf8.count <= 16_384 else { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    /// Call only after the ordinary folder, whiteboard, or document open succeeded.
    /// The stable id survives reopens, while array position reflects this open event
    /// even if the system clock was adjusted backwards.
    @discardableResult
    func recordSuccessfulOpen(kind: RecentBrowseKind, rootURL: URL, relativePath: String = "",
                              title: String, openedAt: Date = Date()) throws -> RecentBrowseEntry {
        guard rootURL.isFileURL, Self.isSafeRelativePath(relativePath, kind: kind),
              openedAt.timeIntervalSinceReferenceDate.isFinite else { throw RecentBrowseError.invalidPath }
        let scoped = rootURL.startAccessingSecurityScopedResource()
        defer { if scoped { rootURL.stopAccessingSecurityScopedResource() } }
        let canonical = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        guard (try canonical.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true else {
            throw RecentBrowseError.unavailableRoot
        }
        _ = try Self.containedDestination(rootURL: canonical, relativePath: relativePath, kind: kind)
        let cleanedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = relativePath.isEmpty ? rootURL.lastPathComponent : (relativePath as NSString).lastPathComponent
        let displayTitle = cleanedTitle.isEmpty ? fallback : cleanedTitle
        guard !displayTitle.isEmpty, displayTitle.utf8.count <= 16_384 else { throw RecentBrowseError.invalidPath }
        let bookmark = try rootURL.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        let rootIdentity = Self.fileIdentity(at: canonical)
        var recorded: RecentBrowseEntry?
        try mutate { snapshot in
            Self.refreshMovedRoots(in: &snapshot)
            let old = snapshot.entries.first {
                $0.kind == kind && $0.relativePath == relativePath && Self.matchesRoot($0, canonical: canonical)
            }
            let entry = RecentBrowseEntry(id: old?.id ?? UUID(), kind: kind, title: displayTitle,
                rootDisplayName: rootURL.lastPathComponent, rootDisplayPath: rootURL.standardizedFileURL.path,
                relativePath: relativePath, lastOpenedAt: openedAt, rootBookmark: bookmark,
                canonicalRootPath: canonical.path, rootFileIdentity: rootIdentity)
            snapshot.entries.removeAll {
                $0.kind == kind && $0.relativePath == relativePath && Self.matchesRoot($0, canonical: canonical)
            }
            snapshot.entries.insert(entry, at: 0)
            snapshot.entries = Array(snapshot.entries.prefix(Self.maximumEntries))
            recorded = entry
        }
        guard let recorded else { throw RecentBrowseError.invalidStorage }
        return recorded
    }

    /// One-time migration from an existing catalogue's recorded successful opens.
    /// Existing entries retain their id, order, title and timestamp. Missing or
    /// unauthorized targets throw so a caller can skip that item and continue.
    @discardableResult
    func recordHistoricalOpen(kind: RecentBrowseKind, rootURL: URL, relativePath: String = "",
                              title: String, openedAt: Date) throws -> Bool {
        guard rootURL.isFileURL, Self.isSafeRelativePath(relativePath, kind: kind),
              openedAt.timeIntervalSinceReferenceDate.isFinite else { throw RecentBrowseError.invalidPath }
        let scoped = rootURL.startAccessingSecurityScopedResource()
        defer { if scoped { rootURL.stopAccessingSecurityScopedResource() } }
        let canonical = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        guard (try canonical.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true else {
            throw RecentBrowseError.unavailableRoot
        }
        let destination = try Self.containedDestination(rootURL: canonical, relativePath: relativePath, kind: kind)
        let values = try destination.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
        guard kind == .folder ? values.isDirectory == true : values.isRegularFile == true else {
            throw RecentBrowseError.unavailableRoot
        }
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = relativePath.isEmpty ? rootURL.lastPathComponent : (relativePath as NSString).lastPathComponent
        let displayTitle = cleaned.isEmpty ? fallback : cleaned
        guard !displayTitle.isEmpty, displayTitle.utf8.count <= 16_384 else { throw RecentBrowseError.invalidPath }
        let bookmark = try rootURL.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
        let rootIdentity = Self.fileIdentity(at: canonical)
        var inserted = false
        try mutate { snapshot in
            guard !snapshot.entries.contains(where: {
                $0.kind == kind && $0.relativePath == relativePath && Self.matchesRoot($0, canonical: canonical)
            }) else { return }
            let entry = RecentBrowseEntry(id: UUID(), kind: kind, title: displayTitle,
                rootDisplayName: rootURL.lastPathComponent, rootDisplayPath: rootURL.standardizedFileURL.path,
                relativePath: relativePath, lastOpenedAt: openedAt, rootBookmark: bookmark,
                canonicalRootPath: canonical.path, rootFileIdentity: rootIdentity)
            // Inserting preserves the relative order of all already-used entries;
            // old catalogue records cannot jump to the top as if just opened.
            let index = snapshot.entries.firstIndex { $0.lastOpenedAt < openedAt } ?? snapshot.entries.endIndex
            snapshot.entries.insert(entry, at: index)
            snapshot.entries = Array(snapshot.entries.prefix(Self.maximumEntries))
            inserted = snapshot.entries.contains { $0.id == entry.id }
        }
        return inserted
    }

    /// Returns the bookmarked root, never a guessed path. The caller's normal vault
    /// connection owns its security scope. A stale but resolvable bookmark may follow
    /// a moved folder; a later successful open refreshes it through recordSuccessfulOpen.
    func resolveRoot(for entry: RecentBrowseEntry) throws -> URL {
        guard Self.isSafeRelativePath(entry.relativePath, kind: entry.kind) else { throw RecentBrowseError.invalidPath }
        var stale = false
        do {
            let root = try URL(resolvingBookmarkData: entry.rootBookmark,
                options: [.withoutUI, .withoutMounting, .withoutImplicitStartAccessing], relativeTo: nil, bookmarkDataIsStale: &stale)
            guard root.isFileURL else { throw RecentBrowseError.unavailableRoot }
            let access = root.startAccessingSecurityScopedResource()
            defer { if access { root.stopAccessingSecurityScopedResource() } }
            if let expected = entry.rootFileIdentity, Self.fileIdentity(at: root) != expected {
                throw RecentBrowseError.unavailableRoot
            }
            return root
        } catch { throw RecentBrowseError.unavailableRoot }
    }

    /// Useful after the caller has opened the returned root's security scope.
    func destinationURL(for entry: RecentBrowseEntry, rootURL: URL) throws -> URL {
        if let expected = entry.rootFileIdentity, Self.fileIdentity(at: rootURL) != expected {
            throw RecentBrowseError.unavailableRoot
        }
        return try Self.containedDestination(rootURL: rootURL, relativePath: entry.relativePath, kind: entry.kind)
    }

    /// Removes navigation metadata only, leaving all documents untouched.
    func remove(id: UUID) throws {
        try mutate { $0.entries.removeAll { $0.id == id } }
    }

    func reload() {
        do {
            // File coordination cannot read a not-yet-created item. Only a real
            // no-such-file result means an empty history; permission errors remain
            // visible and must never be treated as permission to replace records.
            guard try snapshotExists(at: storageURL) else {
                entries = []; storageIssue = nil; return
            }
            let coordinator = NSFileCoordinator()
            var coordinationError: NSError?
            var result: Result<RecentBrowseSnapshot, Error> = .failure(RecentBrowseError.invalidStorage)
            coordinator.coordinate(readingItemAt: storageURL, options: .withoutChanges, error: &coordinationError) { url in
                result = Result { try self.readSnapshot(at: url) }
            }
            if let coordinationError { throw coordinationError }
            entries = try result.get().entries
            storageIssue = nil
        } catch { storageIssue = error.localizedDescription }
    }

    private static func containedDestination(rootURL: URL, relativePath: String, kind: RecentBrowseKind) throws -> URL {
        guard rootURL.isFileURL, isSafeRelativePath(relativePath, kind: kind) else { throw RecentBrowseError.invalidPath }
        let root = rootURL.standardizedFileURL.resolvingSymlinksInPath()
        let prefix = root.path == "/" ? "/" : root.path + "/"
        var destination = root
        // Resolve existing ancestors one at a time. Resolving only the final URL
        // can leave an ancestor symlink unresolved when its final file is absent.
        for component in relativePath.split(separator: "/") {
            destination.appendPathComponent(String(component))
            if let attributes = try? FileManager.default.attributesOfItem(atPath: destination.path),
               attributes[.type] as? FileAttributeType == .typeSymbolicLink {
                let target = try FileManager.default.destinationOfSymbolicLink(atPath: destination.path)
                destination = target.hasPrefix("/") ? URL(fileURLWithPath: target)
                    : destination.deletingLastPathComponent().appendingPathComponent(target)
            }
            destination = destination.standardizedFileURL.resolvingSymlinksInPath()
            guard destination == root || destination.path.hasPrefix(prefix) else { throw RecentBrowseError.invalidPath }
        }
        return destination
    }

    private static func matchesRoot(_ entry: RecentBrowseEntry, canonical: URL) -> Bool {
        if let expected = entry.rootFileIdentity { return fileIdentity(at: canonical) == expected }
        if let resolved = resolvedCanonicalRoot(for: entry) { return resolved.path == canonical.path }
        return entry.canonicalRootPath == canonical.path
    }

    private static func resolvedCanonicalRoot(for entry: RecentBrowseEntry) -> URL? {
        var stale = false
        if let resolved = try? URL(resolvingBookmarkData: entry.rootBookmark,
            options: [.withoutUI, .withoutMounting, .withoutImplicitStartAccessing], relativeTo: nil, bookmarkDataIsStale: &stale),
           resolved.isFileURL {
            let access = resolved.startAccessingSecurityScopedResource()
            defer { if access { resolved.stopAccessingSecurityScopedResource() } }
            // Follow the original folder across a move. If its old pathname now
            // contains another folder, do not steal that original entry's id.
            let canonical = resolved.standardizedFileURL.resolvingSymlinksInPath()
            if let expected = entry.rootFileIdentity, fileIdentity(at: canonical) != expected { return nil }
            return canonical
        }
        return nil
    }

    private static func refreshMovedRoots(in snapshot: inout RecentBrowseSnapshot) {
        var identities = Set<String>()
        snapshot.entries = snapshot.entries.compactMap { entry in
            var refreshed = entry
            if let root = resolvedCanonicalRoot(for: entry), root.path != entry.canonicalRootPath,
               (try? root.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                refreshed = RecentBrowseEntry(id: entry.id, kind: entry.kind, title: entry.title,
                    rootDisplayName: root.lastPathComponent, rootDisplayPath: root.path, relativePath: entry.relativePath,
                    lastOpenedAt: entry.lastOpenedAt, rootBookmark: entry.rootBookmark,
                    canonicalRootPath: root.path, rootFileIdentity: entry.rootFileIdentity)
            }
            // An old pathname can be reused before the moved original is next
            // opened. Refresh identity first; if older metadata already recorded
            // both paths to one folder, keep its most recently opened entry.
            return identities.insert(refreshed.identity).inserted ? refreshed : nil
        }
    }

    /// Filesystem metadata distinguishes a moved directory from a different
    /// directory later occupying the same path. It contains no document data.
    private static func fileIdentity(at root: URL) -> String? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: root.standardizedFileURL.resolvingSymlinksInPath().path),
              let volume = attributes[.systemNumber] as? NSNumber,
              let inode = attributes[.systemFileNumber] as? NSNumber else { return nil }
        return volume.stringValue + ":" + inode.stringValue
    }

    private func ensureDirectory() throws {
        let directory = storageURL.deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: directory.path) {
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw RecentBrowseError.invalidStorage }
        } else {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    private func readSnapshot(at url: URL) throws -> RecentBrowseSnapshot {
        guard try snapshotExists(at: url) else { return RecentBrowseSnapshot() }
        let bytes = try Data(contentsOf: url)
        struct Header: Decodable { let schemaVersion: Int }
        let header = try JSONDecoder().decode(Header.self, from: bytes)
        guard header.schemaVersion == 1 else { throw RecentBrowseError.newerStorage }
        let snapshot = try JSONDecoder().decode(RecentBrowseSnapshot.self, from: bytes)
        try snapshot.validate()
        return snapshot
    }

    private func snapshotExists(at url: URL) throws -> Bool {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try FileManager.default.attributesOfItem(atPath: url.path) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
            return false
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= maximumBytes else {
            throw RecentBrowseError.invalidStorage
        }
        return true
    }

    private func mutate(_ change: (inout RecentBrowseSnapshot) throws -> Void) throws {
        do {
            try ensureDirectory()
            let coordinator = NSFileCoordinator()
            var coordinationError: NSError?
            var result: Result<RecentBrowseSnapshot, Error> = .failure(RecentBrowseError.invalidStorage)
            coordinator.coordinate(writingItemAt: storageURL, options: .forReplacing, error: &coordinationError) { url in
                result = Result {
                    // Decode under the write coordination. Corruption and newer
                    // schemas throw before any atomic replacement can take place.
                    var snapshot = try self.readSnapshot(at: url)
                    try change(&snapshot)
                    try snapshot.validate()
                    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
                    let bytes = try encoder.encode(snapshot)
                    guard bytes.count <= self.maximumBytes else { throw RecentBrowseError.invalidStorage }
                    try bytes.write(to: url, options: .atomic)
                    return snapshot
                }
            }
            if let coordinationError { throw coordinationError }
            entries = try result.get().entries
            storageIssue = nil
        } catch {
            storageIssue = error.localizedDescription
            throw error
        }
    }
}
