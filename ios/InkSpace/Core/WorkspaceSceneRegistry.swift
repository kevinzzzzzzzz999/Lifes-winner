import Foundation

/// Weak references coordinate focus only; models, editing history, restoration,
/// and lifecycle state remain owned by each scene.
@MainActor final class WorkspaceSceneRegistry {
    static let shared = WorkspaceSceneRegistry()
    private struct Entry { weak var store: BoardStore?; let id: String }
    private var entries: [Entry] = []
    private var legacyClaimed = false

    func claimLegacyRestore() -> Bool {
        guard !legacyClaimed else { return false }
        legacyClaimed = true
        return true
    }
    func register(store: BoardStore, id: String) {
        entries.removeAll { $0.store == nil || $0.id == id }
        entries.append(Entry(store: store, id: id))
    }
    /// A disconnected scene may retain its model while its final save finishes.
    /// It must no longer intercept focus/open requests. Match the exact owner:
    /// a late teardown of an old scene cannot unregister a replacement with the
    /// same restoration id.
    func unregister(store: BoardStore) {
        entries.removeAll { $0.store == nil || $0.store === store }
    }
    func store(forWindow id: String) -> BoardStore? { entries.first { $0.id == id }?.store }
    var stores: [BoardStore] { entries.compactMap(\.store) }
    func window(forRoot root: URL) -> String? {
        let path = root.standardizedFileURL.resolvingSymlinksInPath().path
        return entries.first { $0.store?.vaultURL?.standardizedFileURL.resolvingSymlinksInPath().path == path }?.id
    }
    func peerWindow(forBoard url: URL, excluding store: BoardStore) -> String? {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        return entries.first {
            guard let peer = $0.store, peer !== store else { return false }
            return peer.boardURL?.standardizedFileURL.resolvingSymlinksInPath().path == path
        }?.id
    }
}
