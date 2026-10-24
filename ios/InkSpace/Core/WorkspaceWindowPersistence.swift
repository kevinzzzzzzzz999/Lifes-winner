import Foundation

/// Window restoration is separate from the legacy last-used location. A new
/// scene must never inherit a peer's board just because that peer saved last.
struct WorkspaceWindowPersistence {
    let id: String
    let allowsLegacyRestore: Bool
    var defaults: UserDefaults = .standard
    private var prefix: String { "InkSpace.workspace.v1." + id + "." }
    private var navigationKey: String { prefix + "navigation-v1" }

    private struct NavigationJournal: Codable {
        var schemaVersion = 1
        var pending: WorkspaceWindowRequest?
        var lastConsumedToken: UUID?
    }
    enum NavigationError: LocalizedError {
        case invalid, newerVersion
        var errorDescription: String? {
            switch self {
            case .invalid: String(localized: "窗口打开记录暂不可读取，原记录已保留。请从文件夹重新打开资料。")
            case .newerVersion: String(localized: "窗口打开记录由较新版本创建，原记录已保留。请更新应用后重试。")
            }
        }
    }

    private func readNavigationJournal() throws -> NavigationJournal {
        guard let object = defaults.object(forKey: navigationKey) else { return NavigationJournal() }
        guard let bytes = object as? Data else { throw NavigationError.invalid }
        guard bytes.count <= 8 * 1024 * 1024 else { throw NavigationError.invalid }
        struct Header: Decodable { let schemaVersion: Int }
        guard let header = try? JSONDecoder().decode(Header.self, from: bytes) else { throw NavigationError.invalid }
        guard header.schemaVersion == 1 else { throw NavigationError.newerVersion }
        guard let journal = try? JSONDecoder().decode(NavigationJournal.self, from: bytes) else { throw NavigationError.invalid }
        try validate(journal)
        return journal
    }

    private func validate(_ journal: NavigationJournal) throws {
        guard journal.schemaVersion == 1 else { throw NavigationError.newerVersion }
        if let pending = journal.pending {
            guard pending.windowID == id, let token = pending.navigationToken,
                  token != journal.lastConsumedToken,
                  let entry = pending.recentEntry, let bookmark = pending.folderBookmark, !bookmark.isEmpty,
                  RecentBrowseStore.isSafeRelativePath(entry.relativePath, kind: entry.kind),
                  (entry.kind == .folder ? pending.relativePath == nil : pending.relativePath == entry.relativePath) else {
                throw NavigationError.invalid
            }
        }
    }

    private func writeNavigationJournal(_ journal: NavigationJournal) throws {
        try validate(journal)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(journal)
        guard bytes.count <= 8 * 1024 * 1024 else { throw NavigationError.invalid }
        // Pending payload and consumption receipt change together as one
        // preference value, independently of SwiftUI's equal-valued binding.
        defaults.set(bytes, forKey: navigationKey)
    }

    /// Every explicit recent click is a new attempt, even for the same entry.
    /// Persist before asking SwiftUI to focus or create its scene.
    @MainActor func issueNavigation(_ request: WorkspaceWindowRequest) throws -> WorkspaceWindowRequest {
        var journal = try readNavigationJournal()
        var issued = request
        issued.navigationToken = UUID()
        journal.pending = issued
        try writeNavigationJournal(journal)
        return issued
    }

    /// This journal, not a possibly stale WindowGroup binding, is authoritative.
    /// An empty/consumed journal never resurrects the binding's old payload.
    @MainActor func pendingNavigation() throws -> WorkspaceWindowRequest? {
        try readNavigationJournal().pending
    }

    @discardableResult @MainActor func consumeNavigation(token: UUID) throws -> Bool {
        var journal = try readNavigationJournal()
        guard journal.pending?.navigationToken == token else { return false }
        journal.pending = nil
        journal.lastConsumedToken = token
        try writeNavigationJournal(journal)
        return true
    }

    var hasLocation: Bool { defaults.data(forKey: prefix + "vaultBookmark") != nil }
    var location: (bookmark: Data, boardPath: String?)? {
        if let bookmark = defaults.data(forKey: prefix + "vaultBookmark") {
            return (bookmark, defaults.string(forKey: prefix + "lastBoardPath"))
        }
        guard allowsLegacyRestore, let bookmark = defaults.data(forKey: "vaultBookmark") else { return nil }
        return (bookmark, defaults.string(forKey: "lastBoardPath"))
    }

    func seed(bookmark: Data, boardPath: String?, replacingExisting: Bool = false) {
        guard replacingExisting || !hasLocation else { return }
        defaults.set(bookmark, forKey: prefix + "vaultBookmark")
        defaults.set(boardPath, forKey: prefix + "lastBoardPath")
    }

    func rememberVault(_ bookmark: Data) {
        defaults.set(bookmark, forKey: prefix + "vaultBookmark")
        defaults.removeObject(forKey: prefix + "lastBoardPath")
        defaults.set(bookmark, forKey: "vaultBookmark")
        defaults.removeObject(forKey: "lastBoardPath")
    }

    func rememberBoard(_ path: String?) {
        defaults.set(path, forKey: prefix + "lastBoardPath")
        // Keep the background-only legacy pair coherent when a different scene
        // most recently connected a folder.
        if let bookmark = defaults.data(forKey: prefix + "vaultBookmark") {
            defaults.set(bookmark, forKey: "vaultBookmark")
            defaults.set(path, forKey: "lastBoardPath")
        }
    }
}

struct WorkspaceWindowRequest: Codable, Hashable {
    var windowID = UUID().uuidString
    var folderBookmark: Data?
    var relativePath: String?
    var chooseFolder = true
    // A complete ordinary navigation request survives a close between looking
    // up a live scene and presenting it. Only a newly-created scene consumes
    // this fallback; a live scene receives the same request through its store.
    var recentEntry: RecentBrowseEntry? = nil
    var navigationToken: UUID? = UUID()

    mutating func consumeRecentEntry(_ id: UUID) {
        guard recentEntry?.id == id else { return }
        recentEntry = nil
        folderBookmark = nil
        relativePath = nil
        chooseFolder = false
    }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.windowID == rhs.windowID }
    func hash(into hasher: inout Hasher) { hasher.combine(windowID) }
}
