import Foundation
import Observation

struct BoardCatalogVault: Identifiable, Codable, Equatable, Sendable {
    var id: UUID
    var name: String
    var canonicalPath: String
    var bookmark: Data
    var lastConnectedAt: Date
}

struct BoardCatalogEntry: Identifiable, Codable, Equatable, Sendable {
    var id: UUID
    var vaultID: UUID
    var relativePath: String
    var title: String
    var boardID: UUID?
    var hasDocumentTitle = false
    var lastOpenedAt: Date?
    var lastSeenAt: Date?
    var isFavorite = false
    var categoryIDs: Set<UUID> = []
    /// A complete directory scan could not find this path. History is retained.
    var isMissing = false
}

struct BoardCatalogCategory: Identifiable, Codable, Equatable, Sendable {
    var id: UUID
    var name: String
}

private struct BoardCatalogSnapshot: Codable, Sendable {
    var schemaVersion = 1
    var vaults: [BoardCatalogVault] = []
    var entries: [BoardCatalogEntry] = []
    var categories: [BoardCatalogCategory] = []

    func validate() throws {
        guard schemaVersion == 1 else { throw BoardCatalogError.futureVersion }
        let vaultIDs = Set(vaults.map(\.id)), categoryIDs = Set(categories.map(\.id))
        guard vaultIDs.count == vaults.count, Set(entries.map(\.id)).count == entries.count,
              categoryIDs.count == categories.count,
              Set(vaults.map(\.canonicalPath)).count == vaults.count else { throw BoardCatalogError.invalidData }
        var paths: Set<String> = []
        for entry in entries {
            guard vaultIDs.contains(entry.vaultID), VaultPath.isSafeRelative(entry.relativePath),
                  entry.relativePath.hasSuffix(".inkspace.json"),
                  entry.categoryIDs.isSubset(of: categoryIDs),
                  paths.insert(entry.vaultID.uuidString + "/" + entry.relativePath).inserted else {
                throw BoardCatalogError.invalidData
            }
        }
        guard categories.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
            throw BoardCatalogError.invalidData
        }
    }
}

private enum BoardCatalogError: LocalizedError {
    case invalidData, futureVersion, changedExternally, readOnly, invalidPath, authorization, duplicateVault, categoryName
    var errorDescription: String? {
        switch self {
        case .invalidData: String(localized: "白板资料库记录无法读取，原记录已保留。")
        case .futureVersion: String(localized: "这份资料库由较新版本创建，请更新应用后再修改。")
        case .changedExternally: String(localized: "资料库记录已在别处改变。请关闭并重新打开资料库后再试，已有记录未被覆盖。")
        case .readOnly: String(localized: "资料库目前只读。请先恢复资料库记录；白板原文件不受影响。")
        case .invalidPath: String(localized: "此白板不在所选仓库内，无法加入资料库。")
        case .authorization: String(localized: "此仓库暂不可访问，请重新选择它所在的文件夹授权。")
        case .duplicateVault: String(localized: "所选文件夹属于另一个已记录仓库。请选择这条历史记录原来所在的仓库。")
        case .categoryName: String(localized: "请输入不重复的分类名称（最多 80 个字符）。")
        }
    }
}

private struct BoardCatalogDelivery: Sendable {
    let sequence: UInt64
    let snapshot: BoardCatalogSnapshot
    let warning: String?
    let needsRecovery: Bool
    let writable: Bool
    let failureMessage: String?
}

/// The actor serializes app-private metadata writes. It never reads board JSON or writes to a vault.
private actor BoardCatalogDatabase {
    let directory: URL
    private var snapshot = BoardCatalogSnapshot()
    private var loaded = false
    private var expectedPrimary: Data?
    private var warning: String?
    private var needsRecovery = false
    private var writable = true
    private var sequence: UInt64 = 0
    private var failureMessage: String?
    // Persistence is shared by the app's windows, but the current workspace
    // and scan belong to their initiating catalog client. Switching folders in
    // one scene must not invalidate another scene's in-flight directory scan.
    private var activeVaultIDs: [UUID: UUID] = [:]
    private var scanTokens: [UUID: UUID] = [:]
    private let maximumBytes = 64 * 1024 * 1024 // Reject oversized metadata; never truncate history.
    private var primary: URL { directory.appendingPathComponent("catalog-v1.json") }
    private var backup: URL { directory.appendingPathComponent("catalog-v1.backup.json") }

    init(directory: URL) { self.directory = directory }

    private func delivery() -> BoardCatalogDelivery {
        sequence &+= 1
        defer { failureMessage = nil }
        return BoardCatalogDelivery(sequence: sequence, snapshot: snapshot, warning: warning,
                                    needsRecovery: needsRecovery, writable: writable, failureMessage: failureMessage)
    }

    private func read(_ url: URL) throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= maximumBytes else { throw BoardCatalogError.invalidData }
        return try Data(contentsOf: url)
    }

    private func decode(_ data: Data) throws -> BoardCatalogSnapshot {
        struct Header: Decodable { let schemaVersion: Int }
        let header = try JSONDecoder().decode(Header.self, from: data)
        guard header.schemaVersion == 1 else { throw BoardCatalogError.futureVersion }
        let result = try JSONDecoder().decode(BoardCatalogSnapshot.self, from: data)
        try result.validate()
        return result
    }

    private func ensureDirectory() throws {
        if FileManager.default.fileExists(atPath: directory.path) {
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw BoardCatalogError.invalidData }
        } else { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
    }

    func load(reload: Bool = false) -> BoardCatalogDelivery {
        if loaded && !reload { return delivery() }
        loaded = true
        warning = nil; needsRecovery = false; writable = true
        do {
            try ensureDirectory()
            expectedPrimary = try read(primary)
            if let bytes = expectedPrimary { snapshot = try decode(bytes) }
            else if let bytes = try read(backup) {
                snapshot = try decode(bytes); needsRecovery = true; writable = false
                warning = String(localized: "资料库主记录缺失，已读取备份。请恢复记录后继续整理。")
            } else { snapshot = BoardCatalogSnapshot() }
        } catch {
            failureMessage = error.localizedDescription
            writable = false
            if case BoardCatalogError.futureVersion = error {
                warning = error.localizedDescription
                return delivery()
            }
            needsRecovery = true
            if let bytes = try? read(backup), let recovered = try? decode(bytes) {
                snapshot = recovered
                warning = String(localized: "已从备份读取资料库，当前为只读。恢复后才能继续收藏和分类；损坏记录会另存保留。")
            } else {
                warning = String(localized: "资料库记录损坏或暂不可读取，原记录未改动。可重新读取，或保留旧记录后重建资料库；白板文件不会删除。")
            }
        }
        return delivery()
    }

    private func persist(_ candidate: BoardCatalogSnapshot) throws {
        guard writable else { throw BoardCatalogError.readOnly }
        try candidate.validate()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(candidate)
        guard bytes.count <= maximumBytes else { throw BoardCatalogError.invalidData }
        try ensureDirectory()
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var result: Result<Void, Error> = .failure(BoardCatalogError.invalidData)
        coordinator.coordinate(writingItemAt: primary, options: .forReplacing, error: &coordinationError) { target in
            result = Result {
                let existing = try self.read(target)
                guard existing == self.expectedPrimary else { throw BoardCatalogError.changedExternally }
                if let existing {
                    _ = try self.decode(existing)
                    try existing.write(to: self.backup, options: .atomic)
                }
                try bytes.write(to: target, options: .atomic)
            }
        }
        if let coordinationError { throw coordinationError }
        try result.get()
        expectedPrimary = bytes
        snapshot = candidate
        warning = nil
    }

    private func mutate(_ change: (inout BoardCatalogSnapshot) throws -> Void) -> BoardCatalogDelivery {
        _ = load()
        do {
            var next = snapshot
            try change(&next)
            try persist(next)
        } catch {
            warning = error.localizedDescription
            switch error {
            case BoardCatalogError.categoryName, BoardCatalogError.invalidPath, BoardCatalogError.duplicateVault,
                 BoardCatalogError.readOnly: break
            default: failureMessage = error.localizedDescription
            }
            if case BoardCatalogError.changedExternally = error { writable = false }
        }
        return delivery()
    }

    func clearCurrentVault(clientID: UUID) {
        activeVaultIDs.removeValue(forKey: clientID)
        scanTokens.removeValue(forKey: clientID)
    }

    /// Resolve the stored filesystem identity instead of guessing from a folder name.
    /// Bookmarks can follow a moved directory or an iOS app-container migration even
    /// when their stored URL is stale. A successful match is refreshed on attach.
    private func resolvedRootPath(for vault: BoardCatalogVault) -> String? {
        do {
            var stale = false
            let url = try URL(resolvingBookmarkData: vault.bookmark,
                options: [.withoutUI, .withoutMounting, .withoutImplicitStartAccessing],
                relativeTo: nil, bookmarkDataIsStale: &stale)
            guard url.isFileURL else { return nil }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            return try BoardStorageLocations.directory(root: url, relativePath: "").path
        } catch { return nil }
    }

    private func knownVault(at canonicalPath: String) throws -> BoardCatalogVault? {
        var matches: [BoardCatalogVault] = []
        for existing in snapshot.vaults {
            let resolvedPath = resolvedRootPath(for: existing)
            if existing.canonicalPath == canonicalPath {
                // A former pathname may now be occupied by a different folder. When
                // the bookmark proves the old root moved elsewhere, refuse reuse.
                guard resolvedPath == nil || resolvedPath == canonicalPath else { throw BoardCatalogError.duplicateVault }
                matches.append(existing)
            } else if resolvedPath == canonicalPath { matches.append(existing) }
        }
        guard matches.count <= 1 else { throw BoardCatalogError.duplicateVault }
        return matches.first
    }

    func attach(vault: BoardCatalogVault, preferredID: UUID?, clientID: UUID) -> (UUID?, BoardCatalogDelivery) {
        clearCurrentVault(clientID: clientID)
        _ = load()
        let known: BoardCatalogVault?
        do { known = try knownVault(at: vault.canonicalPath) }
        catch { warning = error.localizedDescription; return (nil, delivery()) }
        // Validate identity before taking the read-only path. A known but different vault
        // must never be rebound merely because its index cannot currently be written.
        if let preferredID, let known, known.id != preferredID {
            warning = BoardCatalogError.duplicateVault.localizedDescription
            return (nil, delivery())
        }
        if !writable {
            // A stored or uniquely bookmark-verified identity is usable for this
            // session. Unknown roots still require a durable identity update.
            activeVaultIDs[clientID] = known?.id
            if warning == nil { warning = BoardCatalogError.readOnly.localizedDescription }
            return (known?.id, delivery())
        }
        let result = mutate { next in
            let identity = preferredID ?? known?.id
            let index = identity.flatMap { id in next.vaults.firstIndex { $0.id == id } }
            var updated = vault
            if let index { updated.id = next.vaults[index].id; next.vaults[index] = updated }
            else { next.vaults.append(updated) }
        }
        // A failed update may still use a previously known, verified root identity.
        // An unknown root is never current unless its identity was saved successfully.
        let persisted = snapshot.vaults.first { $0.canonicalPath == vault.canonicalPath }?.id ?? known?.id
        if let persisted, preferredID == nil || preferredID == persisted {
            activeVaultIDs[clientID] = persisted
            return (persisted, result)
        }
        return (nil, result)
    }

    func record(rootPath: String, path: String, title: String, boardID: UUID?, opened: Bool) -> BoardCatalogDelivery {
        mutate { next in
            guard VaultPath.isSafeRelative(path), path.hasSuffix(".inkspace.json"),
                  let vault = next.vaults.first(where: { $0.canonicalPath == rootPath }) else { throw BoardCatalogError.invalidPath }
            let now = Date()
            if let index = next.entries.firstIndex(where: { $0.vaultID == vault.id && $0.relativePath == path }) {
                next.entries[index].title = title
                next.entries[index].hasDocumentTitle = true
                next.entries[index].boardID = boardID
                next.entries[index].lastSeenAt = now
                next.entries[index].isMissing = false
                if opened { next.entries[index].lastOpenedAt = now }
            } else {
                next.entries.append(BoardCatalogEntry(id: UUID(), vaultID: vault.id, relativePath: path,
                    title: title, boardID: boardID, hasDocumentTitle: true,
                    lastOpenedAt: opened ? now : nil, lastSeenAt: now))
            }
        }
    }

    func relocate(rootPath: String, moves: [(from: String, to: String)]) -> BoardCatalogDelivery {
        guard !moves.isEmpty else { return delivery() }
        return mutate { next in
            guard let vault = next.vaults.first(where: { $0.canonicalPath == rootPath }) else { return }
            for index in next.entries.indices where next.entries[index].vaultID == vault.id {
                let original = next.entries[index].relativePath
                let move = moves.first { original == $0.from || original.hasPrefix($0.from + "/") }
                let mapped = move.map { $0.to + original.dropFirst($0.from.count) } ?? original
                guard VaultPath.isSafeRelative(mapped) else { throw BoardCatalogError.invalidPath }
                next.entries[index].relativePath = mapped
            }
            let identities = next.entries.map { $0.vaultID.uuidString + "/" + $0.relativePath }
            guard Set(identities).count == identities.count else { throw BoardCatalogError.invalidData }
        }
    }

    func startScan(vaultID: UUID, token: UUID, clientID: UUID) {
        if activeVaultIDs[clientID] == vaultID { scanTokens[clientID] = token }
    }
    func mergeScan(vaultID: UUID, token: UUID, clientID: UUID, paths: [String], complete: Bool) -> BoardCatalogDelivery {
        guard !Task.isCancelled, activeVaultIDs[clientID] == vaultID,
              scanTokens[clientID] == token else { return delivery() }
        return mutate { next in
            let now = Date(), found = Set(paths)
            var indices = Dictionary(uniqueKeysWithValues: next.entries.enumerated()
                .filter { $0.element.vaultID == vaultID }.map { ($0.element.relativePath, $0.offset) })
            if complete {
                for index in next.entries.indices where next.entries[index].vaultID == vaultID {
                    next.entries[index].isMissing = !found.contains(next.entries[index].relativePath)
                }
            }
            for path in paths where VaultPath.isSafeRelative(path) && path.hasSuffix(".inkspace.json") {
                if let index = indices[path] { next.entries[index].lastSeenAt = now; next.entries[index].isMissing = false }
                else {
                    indices[path] = next.entries.count
                    next.entries.append(BoardCatalogEntry(id: UUID(), vaultID: vaultID, relativePath: path,
                        title: String(URL(fileURLWithPath: path).lastPathComponent.dropLast(".inkspace.json".count)),
                        lastSeenAt: now))
                }
            }
        }
    }

    func favorite(_ entryID: UUID, value: Bool) -> BoardCatalogDelivery {
        mutate { next in if let index = next.entries.firstIndex(where: { $0.id == entryID }) { next.entries[index].isFavorite = value } }
    }
    func membership(_ entryID: UUID, categoryID: UUID, included: Bool) -> BoardCatalogDelivery {
        mutate { next in
            guard next.categories.contains(where: { $0.id == categoryID }),
                  let index = next.entries.firstIndex(where: { $0.id == entryID }) else { throw BoardCatalogError.invalidData }
            if included { next.entries[index].categoryIDs.insert(categoryID) }
            else { next.entries[index].categoryIDs.remove(categoryID) }
        }
    }
    func category(_ category: BoardCatalogCategory) -> BoardCatalogDelivery {
        mutate { next in
            let name = category.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.count <= 80,
                  !next.categories.contains(where: { $0.id != category.id && $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }) else {
                throw BoardCatalogError.categoryName
            }
            let trimmed = BoardCatalogCategory(id: category.id, name: name)
            if let index = next.categories.firstIndex(where: { $0.id == category.id }) { next.categories[index] = trimmed }
            else { next.categories.append(trimmed) }
        }
    }
    func deleteCategory(_ id: UUID) -> BoardCatalogDelivery {
        mutate { next in
            next.categories.removeAll { $0.id == id }
            for index in next.entries.indices { next.entries[index].categoryIDs.remove(id) }
        }
    }

    func recover() -> BoardCatalogDelivery {
        _ = load()
        guard needsRecovery else { return delivery() }
        do {
            try ensureDirectory()
            // Explicit user recovery preserves every byte of the unreadable local index first.
            // No source board or vault file is touched, and a new unknown index is never overwritten.
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            let bytes = try encoder.encode(snapshot)
            let coordinator = NSFileCoordinator()
            var coordinationError: NSError?
            var result: Result<Void, Error> = .failure(BoardCatalogError.invalidData)
            coordinator.coordinate(writingItemAt: primary, options: .forReplacing, error: &coordinationError) { target in
                result = Result {
                    let current = try self.read(target)
                    guard current == self.expectedPrimary else { throw BoardCatalogError.changedExternally }
                    if let current {
                        try current.write(to: self.directory.appendingPathComponent("catalog-damaged-\(UUID().uuidString).json"), options: .withoutOverwriting)
                    }
                    try bytes.write(to: target, options: .atomic)
                }
            }
            if let coordinationError { throw coordinationError }
            try result.get()
            expectedPrimary = bytes; writable = true; needsRecovery = false; warning = nil
        } catch { writable = false; warning = error.localizedDescription; failureMessage = error.localizedDescription }
        return delivery()
    }
}

/// Persistent app-private history and virtual organization. Bookmark URLs are returned without
/// acquiring a security scope: the caller owns access while opening/switching the actual board.
@MainActor @Observable final class BoardCatalogStore {
    // One actor owns each private metadata file. Independent actors with cached
    // expectedPrimary bytes would mistake a sibling window's valid write for an
    // external edit and make its history permanently read-only. The coordinated
    // compare-and-swap inside the actor still rejects actual external changes.
    private static var databases: [String: BoardCatalogDatabase] = [:]
    private static func sharedDatabase(directory: URL) -> BoardCatalogDatabase {
        let key = directory.standardizedFileURL.path
        if let existing = databases[key] { return existing }
        let database = BoardCatalogDatabase(directory: directory)
        databases[key] = database
        return database
    }
    private(set) var entries: [BoardCatalogEntry] = []
    private(set) var vaults: [BoardCatalogVault] = []
    private(set) var categories: [BoardCatalogCategory] = []
    private(set) var currentVaultID: UUID?
    private(set) var isScanning = false
    private(set) var warning: String?
    private(set) var scanWarning: String?
    private(set) var needsRecovery = false
    private(set) var isWritable = true
    @ObservationIgnored private let database: BoardCatalogDatabase
    @ObservationIgnored private let clientID = UUID()
    @ObservationIgnored private let onFailure: @MainActor (String) -> Void
    @ObservationIgnored private let discover: @Sendable (URL) async -> BoardFileListing
    @ObservationIgnored private var currentRootURL: URL?
    @ObservationIgnored private var scanGeneration = UUID()
    @ObservationIgnored private var lastSequence: UInt64 = 0

    init(directoryURL: URL? = nil, onFailure: @escaping @MainActor (String) -> Void = { _ in },
         discover: @escaping @Sendable (URL) async -> BoardFileListing = { await BoardStorageLocations.discover(root: $0) }) {
        let base = directoryURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BoardCatalog", isDirectory: true)
        database = Self.sharedDatabase(directory: base)
        self.discover = discover
        self.onFailure = onFailure
    }

    deinit {
        let database = database, clientID = clientID
        Task { await database.clearCurrentVault(clientID: clientID) }
    }

    private func apply(_ result: BoardCatalogDelivery) {
        guard result.sequence > lastSequence else { return }
        lastSequence = result.sequence
        entries = result.snapshot.entries; vaults = result.snapshot.vaults; categories = result.snapshot.categories
        warning = result.warning; needsRecovery = result.needsRecovery; isWritable = result.writable
        if let failure = result.failureMessage { onFailure(failure) }
    }
    func load() async { apply(await database.load(reload: true)) }

    @discardableResult func attach(rootURL: URL, preferredVaultID: UUID? = nil) async -> UUID? {
        let generation = UUID()
        scanGeneration = generation; isScanning = false; scanWarning = nil
        // The app may already have switched its workspace. Never keep a previous
        // current-vault mapping when validation or persistence of this root fails.
        currentVaultID = nil; currentRootURL = nil
        await database.clearCurrentVault(clientID: clientID)
        guard scanGeneration == generation else { return nil }
        do {
            let access = rootURL.startAccessingSecurityScopedResource()
            defer { if access { rootURL.stopAccessingSecurityScopedResource() } }
            let canonical = try BoardStorageLocations.directory(root: rootURL, relativePath: "")
            let bookmark = try rootURL.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
            let vault = BoardCatalogVault(id: preferredVaultID ?? UUID(), name: rootURL.lastPathComponent,
                canonicalPath: canonical.path, bookmark: bookmark, lastConnectedAt: Date())
            let (id, result) = await database.attach(vault: vault, preferredID: preferredVaultID, clientID: clientID)
            apply(result)
            guard scanGeneration == generation else { return nil }
            if let id { currentVaultID = id; currentRootURL = rootURL }
            return id
        } catch { warning = error.localizedDescription; onFailure(error.localizedDescription); return nil }
    }

    func authorizedURL(for vaultID: UUID) throws -> URL {
        guard let vault = vaults.first(where: { $0.id == vaultID }) else { throw BoardCatalogError.authorization }
        var stale = false
        let url = try URL(resolvingBookmarkData: vault.bookmark, options: [.withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
        guard url.isFileURL, !stale else { throw BoardCatalogError.authorization }
        return url
    }

    func recordOpened(rootURL: URL, relativePath: String, title: String, boardID: UUID? = nil) async {
        await record(rootURL: rootURL, relativePath: relativePath, title: title, boardID: boardID, opened: true)
    }
    func recordSaved(rootURL: URL, relativePath: String, title: String, boardID: UUID? = nil) async {
        await record(rootURL: rootURL, relativePath: relativePath, title: title, boardID: boardID, opened: false)
    }
    private func record(rootURL: URL, relativePath: String, title: String, boardID: UUID?, opened: Bool) async {
        let path = rootURL.standardizedFileURL.resolvingSymlinksInPath().path
        apply(await database.record(rootPath: path, path: relativePath, title: title, boardID: boardID, opened: opened))
    }

    func relocate(rootURL: URL, moves: [(from: String, to: String)]) async {
        apply(await database.relocate(rootPath: rootURL.standardizedFileURL.resolvingSymlinksInPath().path, moves: moves))
    }

    func refreshCurrentVault() async {
        guard let root = currentRootURL, let vaultID = currentVaultID else { return }
        let token = UUID(); scanGeneration = token; isScanning = true; scanWarning = nil
        await database.startScan(vaultID: vaultID, token: token, clientID: clientID)
        let result = await discover(root)
        guard scanGeneration == token, currentVaultID == vaultID, !Task.isCancelled else {
            if scanGeneration == token { isScanning = false }
            return
        }
        let paths = result.files.compactMap { Self.relativePath(of: $0, within: root) }
        apply(await database.mergeScan(vaultID: vaultID, token: token, clientID: clientID, paths: paths, complete: result.warning == nil))
        guard scanGeneration == token, currentVaultID == vaultID, !Task.isCancelled else { return }
        scanWarning = result.warning; isScanning = false
        if let failure = result.warning { onFailure(failure) }
    }

    static func relativePath(of url: URL, within root: URL) -> String? {
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        let target = url.standardizedFileURL.resolvingSymlinksInPath().path
        guard target.hasPrefix(base) else { return nil }
        let relative = String(target.dropFirst(base.count))
        return VaultPath.isSafeRelative(relative) ? relative : nil
    }
    func isCurrent(_ entry: BoardCatalogEntry, boardURL: URL?) -> Bool {
        guard entry.vaultID == currentVaultID, let root = currentRootURL, let boardURL else { return false }
        return Self.relativePath(of: boardURL, within: root) == entry.relativePath
    }
    func vaultLabel(for entry: BoardCatalogEntry) -> String {
        guard let vault = vaults.first(where: { $0.id == entry.vaultID }) else { return String(localized: "仓库不可用") }
        return vault.name + " · " + String(vault.id.uuidString.prefix(6))
    }
    func matches(_ entry: BoardCatalogEntry, query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || [entry.title, entry.relativePath, vaultLabel(for: entry)]
            .contains { $0.localizedCaseInsensitiveContains(query) }
    }
    func setFavorite(_ entryID: UUID, _ value: Bool) async { apply(await database.favorite(entryID, value: value)) }
    func setCategory(_ categoryID: UUID, for entryID: UUID, included: Bool) async {
        apply(await database.membership(entryID, categoryID: categoryID, included: included))
    }
    @discardableResult func saveCategory(id: UUID = UUID(), name: String) async -> Bool {
        apply(await database.category(BoardCatalogCategory(id: id, name: name)))
        return warning == nil
    }
    func deleteCategory(_ id: UUID) async { apply(await database.deleteCategory(id)) }
    func recoverCatalog() async { apply(await database.recover()) }
}
