import Foundation
import PencilKit

/// All file coordination, hashing, JSON validation and native ink decoding run
/// outside MainActor. Only a fully prepared value may replace a visible board.
actor BoardReadLoader {
    static let maximumBytes = 256 * 1024 * 1024
    struct Loaded {
        let document: BoardDocument
        let drawing: PKDrawing
        let fingerprint: String
    }
    enum Change {
        case unchanged
        case deferred
        case loaded(Loaded)
    }
    private struct Stamp: Equatable {
        let size: UInt64
        let modified: Date?
        let inode: UInt64?
    }
    private var observed: [URL: (Stamp, String, Date)] = [:]
    private var assetStamps: [String: Stamp] = [:]
    private var assetScope: URL?

    func load(_ url: URL) throws -> Loaded {
        let (bytes, fingerprint, stamp) = try read(url)
        let result = try decode(bytes, fingerprint: fingerprint)
        observed = [url: (stamp, fingerprint, Date())]
        return result
    }
    func changed(_ url: URL, expectedFingerprint: String, allowReload: Bool,
                 force: Bool = false, maximumBytes: Int = BoardReadLoader.maximumBytes) throws -> Change {
        try Task.checkCancellation()
        let metadata = try stamp(url)
        if !force, let old = observed[url], old.0 == metadata,
           Date().timeIntervalSince(old.2) < 60 {
            if old.1 == expectedFingerprint { return .unchanged }
            if !allowReload { return .deferred }
        }
        let (bytes, fingerprint, stableStamp) = try read(url, maximumBytes: maximumBytes)
        observed = [url: (stableStamp, fingerprint, Date())]
        guard fingerprint != expectedFingerprint else { return .unchanged }
        guard allowReload else { return .deferred }
        return .loaded(try decode(bytes, fingerprint: fingerprint))
    }
    /// Paths are exact vault-relative references; this does not scan the vault.
    func linkedAssetsChanged(root: URL, paths: Set<String>) throws -> Bool {
        try Task.checkCancellation()
        var current: [String: Stamp] = [:]
        for path in paths.sorted().prefix(10_000) {
            try Task.checkCancellation()
            guard let url = VaultPathResolver.resolve(relativePath: path, within: root) else { continue }
            if let value = try? stamp(url) { current[path] = value }
        }
        let changed = assetScope == root && current != assetStamps
        assetScope = root; assetStamps = current
        return changed
    }
    private func decode(_ bytes: Data, fingerprint: String) throws -> Loaded {
        try Task.checkCancellation()
        let board = try BoardDocument.decode(bytes)
        try Task.checkCancellation()
        let drawing = try board.drawing.map(PKDrawing.init(data:)) ?? PKDrawing()
        try Task.checkCancellation()
        return Loaded(document: board, drawing: drawing, fingerprint: fingerprint)
    }
    private func stamp(_ url: URL) throws -> Stamp {
        let values = try FileManager.default.attributesOfItem(atPath: url.path)
        guard values[.type] as? FileAttributeType == .typeRegular,
              let size = values[.size] as? NSNumber else { throw VaultWriteError.unavailable }
        return Stamp(size: size.uint64Value, modified: values[.modificationDate] as? Date,
                     inode: (values[.systemFileNumber] as? NSNumber)?.uint64Value)
    }
    private func read(_ url: URL, maximumBytes: Int = BoardReadLoader.maximumBytes) throws -> (Data, String, Stamp) {
        try Task.checkCancellation()
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<(Data, String, Stamp), Error> = .failure(VaultWriteError.unavailable)
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { target in
            result = Result {
                let before = try stamp(target)
                let limit = max(0, min(Self.maximumBytes, maximumBytes))
                guard before.size <= UInt64(limit) else { throw ReadError.tooLarge }
                let handle = try FileHandle(forReadingFrom: target)
                defer { try? handle.close() }
                let bytes = try handle.read(upToCount: Int(before.size) + 1) ?? Data()
                guard bytes.count <= limit else { throw ReadError.tooLarge }
                try Task.checkCancellation()
                guard try stamp(target) == before else { throw VaultWriteError.externalChange }
                return (bytes, VaultFileIO.fingerprint(bytes), before)
            }
        }
        if let coordinationError { throw coordinationError }
        return try result.get()
    }
    enum ReadError: LocalizedError {
        case tooLarge
        var errorDescription: String? { String(localized: "白板超过读取上限，当前内容已保留。") }
    }
}

/// A suspended read never gains permission to replace later local work.
struct BoardRefreshIdentity: Equatable {
    let session: UUID
    let boardID: UUID
    let generation: Int
    let fingerprint: String
    let url: URL
    func mayApply(current: BoardRefreshIdentity?, dirty: Bool, saving: Bool,
                  busy: Bool, editing: Bool) -> Bool {
        self == current && !dirty && !saving && !busy && !editing
    }
}
