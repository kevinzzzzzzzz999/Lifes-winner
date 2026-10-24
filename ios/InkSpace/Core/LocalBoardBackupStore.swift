import Foundation
import CryptoKit
#if os(iOS)
import os
#endif

/// Local storage is intentionally separate from the authorized vault and excluded
/// from iCloud device backup. Export a package before deleting this app.
enum BoardBackupReason: String, Codable, Sendable { case checkpoint, session, manual }
struct BoardBackupPolicy: Codable, Equatable, Sendable {
    var sessionCount: Int = 10
    var maximumBytes: UInt64 = 2 * 1024 * 1024 * 1024
    var maximumAssetBytes: UInt64 = 256 * 1024 * 1024
    func validate() throws {
        guard (1...100).contains(sessionCount), maximumBytes >= 1024 * 1024,
              maximumBytes <= 16 * 1024 * 1024 * 1024, maximumAssetBytes > 0,
              maximumAssetBytes <= 256 * 1024 * 1024 else { throw BoardBackupError.limit }
    }
}
struct BoardBackupAsset: Codable, Equatable, Sendable {
    var path: String
    var sha256: String
    var bytes: UInt64
    /// Metadata is only a checkpoint optimization, never an export/restore trust decision.
    var stamp: String
}
struct BoardBackupMissing: Codable, Equatable, Sendable { var path: String; var reason: String }
struct BoardBackupRecord: Codable, Identifiable, Sendable {
    var version = 1
    var id: UUID
    var boardID: UUID
    var title: String
    var date: Date
    var reason: BoardBackupReason
    var complete: Bool
    var editableOnly: Bool
    var boardSHA256: String
    var contentSHA256: String
    var assets: [BoardBackupAsset]
    var missing: [BoardBackupMissing]
    var bytes: UInt64
    /// Optional in schema 1 so older packages remain readable. This asset is a
    /// board companion, not a source document to relocate into Sources/.
    var writingAidTapePath: String? = nil
}
struct BoardBackupCaptureResult: Sendable { var record: BoardBackupRecord?; var disabled = false; var unchanged = false }
#if INKSPACE_BACKUP_TESTING
/// Test builds observe actual completed writes and inject deterministic races.
/// This hook is absent from the application binary.
enum BoardBackupCaptureEvent: Sendable {
    case sourceHashed(String)
    case assetBytesWritten(String, Int)
    case assetReused(String, UInt64)
    case restorePrepared(UUID, URL)
    case restoreTapePublished(UUID, URL)
}
#endif
enum BoardBackupError: LocalizedError {
    case unsafePath, limit, changed, incomplete, corrupt, unsupportedPDF, missingVersion, memoryPressure
    var errorDescription: String? {
        switch self {
        case .memoryPressure: String(localized: "当前内存不足，本次辅助备份已暂缓；已有版本保留，正常白板保存继续进行。")
        case .unsafePath: String(localized: "备份路径不安全，或文件使用了符号链接。")
        case .limit: String(localized: "本机备份容量或单文件限额不足；已有版本保留，正常白板保存不受影响。")
        case .changed: String(localized: "资料在备份期间发生变化，请稍后重试。")
        case .incomplete: String(localized: "这个版本缺少关联资料。可编辑笔迹已保留，请等资料下载完成后创建完整备份。")
        case .corrupt: String(localized: "备份校验不一致，已停止恢复；现有文件保持不变。")
        case .unsupportedPDF: String(localized: "此备份的 PDF 无法安全移除旧白板批注，已停止恢复；原白板和备份保持不变。")
        case .missingVersion: String(localized: "没有找到这个本机备份版本。")
        }
    }
}

private final class BackupReadCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var coordinator: NSFileCoordinator?
    private var cancelled = false
    func begin(_ value: NSFileCoordinator) throws {
        lock.lock(); defer { lock.unlock() }
        guard !cancelled else { throw CancellationError() }; coordinator = value
    }
    func end() { lock.lock(); coordinator = nil; lock.unlock() }
    func cancel() {
        lock.lock(); cancelled = true; let value = coordinator; lock.unlock(); value?.cancel()
    }
}

actor LocalBoardBackupStore {
    private struct Settings: Codable { var disabled: Set<String> = []; var policy = BoardBackupPolicy() }
    private struct Index: Codable { var checkpoint: UUID?; var history: [UUID] = []; var latestComplete: UUID? }
    let rootURL: URL
    private var settings: Settings
    private var newestGeneration: [String: UInt64] = [:]
    private var newestCompleteGeneration: [String: UInt64] = [:]
    private let fm = FileManager.default
    static let maximumBoardBytes = 256 * 1024 * 1024
#if INKSPACE_BACKUP_TESTING
    private var captureObserver: (@Sendable (BoardBackupCaptureEvent) -> Void)?
    func observeCapture(_ observer: (@Sendable (BoardBackupCaptureEvent) -> Void)?) { captureObserver = observer }
#endif

    init(rootURL: URL? = nil) throws {
        let base = rootURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("InkSpace/LocalBackups", isDirectory: true)
        self.rootURL = base.standardizedFileURL
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var excluded = base; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        let settingsURL = base.appendingPathComponent("settings.json")
        if FileManager.default.fileExists(atPath: settingsURL.path) {
            settings = try JSONDecoder().decode(Settings.self, from: Data(contentsOf: settingsURL))
            try settings.policy.validate()
        } else { settings = Settings() }
        try FileManager.default.createDirectory(at: base.appendingPathComponent("blobs"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: base.appendingPathComponent("boards"), withIntermediateDirectories: true)
    }
    static func scope(document: BoardDocument, vaultURL: URL) -> String {
        digest(Data((vaultURL.standardizedFileURL.resolvingSymlinksInPath().path + "\n" + document.id.uuidString).utf8))
    }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func isEnabled(scope: String) -> Bool { !settings.disabled.contains(scope) }
    func policy() -> BoardBackupPolicy { settings.policy }
    func setEnabled(_ enabled: Bool, scope: String) throws {
        if enabled { settings.disabled.remove(scope) } else { settings.disabled.insert(scope) }
        try saveSettings()
    }
    func setPolicy(_ policy: BoardBackupPolicy) throws { try policy.validate(); settings.policy = policy; try saveSettings() }
    private func saveSettings() throws { try JSONEncoder().encode(settings).write(to: rootURL.appendingPathComponent("settings.json"), options: .atomic) }

    /// Synchronous actor work never occupies MainActor. Generations are assigned
    /// at request time, so an older full capture cannot replace a newer journal.
    func capture(document: BoardDocument, vaultURL: URL, reason: BoardBackupReason,
                 generation: UInt64, editableOnly: Bool = false) async throws -> BoardBackupCaptureResult {
        let cancellation = BackupReadCancellation()
        return try await withTaskCancellationHandler(operation: {
            try autoreleasepool {
                // Cooperative actor threads have no guaranteed per-request pool.
                // Release JSONEncoder/NSData/PDF temporaries after every backup,
                // rather than retaining them across repeated autosaves.
                try captureNow(document: document, vaultURL: vaultURL, reason: reason, generation: generation, editableOnly: editableOnly, cancellation: cancellation)
            }
        }, onCancel: { cancellation.cancel() })
    }
    private func captureNow(document: BoardDocument, vaultURL: URL, reason: BoardBackupReason,
                            generation: UInt64, editableOnly: Bool, cancellation: BackupReadCancellation) throws -> BoardBackupCaptureResult {
        try Task.checkCancellation(); let scope = Self.scope(document: document, vaultURL: vaultURL)
        guard isEnabled(scope: scope) else { return .init(disabled: true) }
        newestGeneration[scope] = max(newestGeneration[scope] ?? 0, generation)
        var committed = false
        defer { if !committed { try? collectGarbage() } }
        try Self.checkEncodingMemory(document: document)
        let board = try document.encode()
        guard board.count <= Self.maximumBoardBytes else { throw BoardBackupError.limit }
        let oldIndex = try readIndex(scope), old = try oldIndex.checkpoint.map { try readRecord(scope, $0) }
        let paths = Set(document.items.flatMap { [$0.sourcePath, $0.originalSourcePath].compactMap { $0 } })
            .union(document.pdfOwnedSourcePaths ?? [])
        guard paths.count <= 10000 else { throw BoardBackupError.limit }
        var assets: [BoardBackupAsset] = [], missing: [BoardBackupMissing] = []
        var writingAidTapePath: String?
        var queue = paths.sorted(), discovered = Set(queue), used = try storageBytes()
        let prior = Dictionary(uniqueKeysWithValues: (old?.assets ?? []).map { ($0.path, $0) })
        // A journal conservatively remains incomplete even when an older attachment
        // exists: no cloud availability or attachment freshness is claimed here.
        if editableOnly {
            assets = paths.compactMap { prior[$0] }
            missing = paths.sorted().map { .init(path: $0, reason: String(localized: "本次仅保留可编辑状态，关联资料尚未重新核对")) }
            if let path = old?.writingAidTapePath, let asset = prior[path] {
                writingAidTapePath = path
                if !assets.contains(where: { $0.path == path }) {
                    assets.append(asset)
                    missing.append(.init(path: path, reason: String(localized: "本次仅保留可编辑状态，胶带尚未重新核对")))
                }
            }
        } else {
            let access = vaultURL.startAccessingSecurityScopedResource(); defer { if access { vaultURL.stopAccessingSecurityScopedResource() } }
            var cursor = 0
            while cursor < queue.count {
                try Task.checkCancellation(); let path = queue[cursor]; cursor += 1
                guard discovered.count <= 10000 else { throw BoardBackupError.limit }
                do {
                    let url = try Self.resolve(path, under: vaultURL)
                    let asset = try captureAsset(path: path, url: url, previous: prior[path],
                                                 allowCache: reason == .checkpoint, used: &used, cancellation: cancellation)
                    assets.append(asset)
                    if ["md", "markdown"].contains(url.pathExtension.lowercased()) {
                        guard asset.bytes <= 2 * 1024 * 1024 else { throw BoardBackupError.limit }
                        let text = try String(contentsOf: blobURL(asset.sha256), encoding: .utf8)
                        let references = try BackupMarkdownReferences.images(in: text, sourcePath: path)
                        for reference in references where discovered.insert(reference).inserted { queue.append(reference) }
                    }
                } catch is CancellationError { throw CancellationError() }
                catch BoardBackupError.limit { throw BoardBackupError.limit }
                catch { missing.append(.init(path: path, reason: error.localizedDescription)) }
            }
            // Tape is deliberately independent of BoardDocument. A complete
            // checkpoint must nevertheless preserve it, including tape-only edits.
            // Never convert unreadable/newer tape into a successful empty backup.
            let tapePath = Self.tapePath(boardID: document.id)
            if let url = try Self.optionalTapeURL(boardID: document.id, root: vaultURL) {
                guard try Self.metadata(url).size <= UInt64(BoardWritingAidTapeDocument.maximumBytes) else { throw BoardBackupError.limit }
                let asset = try captureAsset(path: tapePath, url: url, previous: prior[tapePath],
                                             allowCache: false, used: &used, cancellation: cancellation)
                _ = try verifiedTape(asset: asset, boardID: document.id)
                assets.removeAll { $0.path == tapePath }; assets.append(asset)
                writingAidTapePath = tapePath
            }
        }
        assets.sort { $0.path < $1.path }; missing.sort { $0.path < $1.path }
        var semantic = document; semantic.previewPNG = nil; semantic.revision = 0; semantic.updatedAt = semantic.createdAt; semantic.writerID = UUID(uuidString: "00000000-0000-0000-0000-000000000000")!
        try Self.checkEncodingMemory(document: semantic)
        // Hash incrementally; concatenating two Data values duplicates the full
        // encoded whiteboard just to append a small attachment manifest.
        var contentHash = SHA256()
        try autoreleasepool { contentHash.update(data: try semantic.encode()) }
        contentHash.update(data: Data(assets.map { $0.path + ":" + $0.sha256 }.joined(separator: "\n").utf8))
        let content = contentHash.finalize().map { String(format: "%02x", $0) }.joined()
        let complete = !editableOnly && missing.isEmpty
        if let old, old.contentSHA256 == content, old.complete == complete, old.editableOnly == editableOnly,
           reason == .checkpoint { return .init(record: old, unchanged: true) }
        if reason == .session, let previous = oldIndex.history.first,
           let record = try? readRecord(scope, previous), record.contentSHA256 == content, record.complete == complete {
            return .init(record: record, unchanged: true)
        }
        let record = BoardBackupRecord(id: UUID(), boardID: document.id, title: document.title, date: Date(),
            reason: reason, complete: complete, editableOnly: editableOnly, boardSHA256: Self.digest(board),
            contentSHA256: content, assets: assets, missing: missing, bytes: UInt64(board.count) + assets.reduce(0) { $0 + $1.bytes },
            writingAidTapePath: writingAidTapePath)
        guard used + UInt64(board.count) + 1024 * 1024 <= settings.policy.maximumBytes else { throw BoardBackupError.limit }
        try validate(record)
        try publish(record: record, board: board, scope: scope, generation: generation)
        committed = true
        return .init(record: record)
    }

    /// Recovery is auxiliary: never begin an optional large allocation while
    /// the OS reports pressure. Normal save has its own independent worker.
    static func requiredEncodingHeadroom(estimatedBytes: UInt64) -> UInt64 {
        let reserve: UInt64 = 128 * 1024 * 1024
        let multiplier: UInt64 = 4
        guard estimatedBytes <= (UInt64.max - reserve) / multiplier else { return UInt64.max }
        return reserve + estimatedBytes * multiplier
    }
    private static func checkEncodingMemory(document: BoardDocument) throws {
#if os(iOS)
        let estimate = estimatedEncodingBytes(document)
        guard UInt64(os_proc_available_memory()) >= requiredEncodingHeadroom(estimatedBytes: estimate) else {
            throw BoardBackupError.memoryPressure
        }
#endif
    }
    // Conservative, allocation-light sizing; do not encode merely to discover
    // whether a large JSONEncoder allocation is safe. Saturation avoids overflow.
    static func estimatedEncodingBytes(_ document: BoardDocument) -> UInt64 {
        var total: UInt64 = 1024 * 1024
        func add(_ value: UInt64) { total = total.addingReportingOverflow(value).overflow ? UInt64.max : total + value }
        func count(_ value: Int, times factor: UInt64) {
            let n = UInt64(max(0, value)); let product = n.multipliedReportingOverflow(by: factor)
            add(product.overflow ? UInt64.max : product.partialValue)
        }
        func string(_ value: String?) { if let value { count(value.utf8.count, times: 6) } }
        func data(_ value: Data?) { if let value { count(value.count, times: 2) } }
        func metadata(_ value: BoardSourceJSONValue) {
            add(32)
            switch value {
            case .string(let value): string(value)
            case .array(let values): for value in values { metadata(value) }
            case .object(let values): for (key, value) in values { string(key); metadata(value) }
            default: break
            }
        }
        string(document.title); data(document.drawing); data(document.previewPNG)
        count(document.items.count, times: 2048); count(document.edges.count, times: 512); count(document.pins.count, times: 512)
        for item in document.items {
            string(item.title); string(item.text); string(item.richTextHTML); string(item.sourcePath)
            string(item.originalSourcePath); string(item.url); data(item.inkData)
            for (key, value) in item.boardNotesObject ?? [:] { string(key); metadata(value) }
        }
        for (key, value) in document.boardNotesImport ?? [:] { string(key); metadata(value) }
        for stroke in document.webInk?.strokes ?? [] {
            count(stroke.points.count, times: 160)
            count(stroke.clipPath?.count ?? 0, times: 200)
        }
        for pin in document.pins { string(pin.title) }
        return total
    }

    private func captureAsset(path: String, url: URL, previous: BoardBackupAsset?, allowCache: Bool, used: inout UInt64, cancellation: BackupReadCancellation) throws -> BoardBackupAsset {
        _ = try Self.metadata(url) // Refuse a cloud placeholder before requesting file coordination.
        let coordinator = NSFileCoordinator(); var coordinationError: NSError?, result: Result<BoardBackupAsset, Error>?
        try cancellation.begin(coordinator); defer { cancellation.end() }
        coordinator.coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { safeURL in
            result = Result {
                try Task.checkCancellation()
                let before = try Self.metadata(safeURL)
                guard before.size <= settings.policy.maximumAssetBytes else { throw BoardBackupError.limit }
                if allowCache, let previous, previous.stamp == before.stamp, previous.bytes == before.size,
                   try hasVerifiedBlob(sha: previous.sha256, bytes: before.size) {
                    try Task.checkCancellation()
                    guard try Self.metadata(safeURL).stamp == before.stamp else { throw BoardBackupError.changed }
#if INKSPACE_BACKUP_TESTING
                    captureObserver?(.assetReused(path, before.size))
#endif
                    return previous
                }
                // Session/manual backups always read every source byte. Hash before
                // staging so unchanged large attachments cause no temporary writes.
                let sha = try Self.hashFile(safeURL, maximumBytes: settings.policy.maximumAssetBytes)
                guard try Self.metadata(safeURL).stamp == before.stamp else { throw BoardBackupError.changed }
#if INKSPACE_BACKUP_TESTING
                captureObserver?(.sourceHashed(path))
#endif
                try Task.checkCancellation()
                if try hasVerifiedBlob(sha: sha, bytes: before.size) {
                    try Task.checkCancellation()
                    guard try Self.metadata(safeURL).stamp == before.stamp else { throw BoardBackupError.changed }
#if INKSPACE_BACKUP_TESTING
                    captureObserver?(.assetReused(path, before.size))
#endif
                    return .init(path: path, sha256: sha, bytes: before.size, stamp: before.stamp)
                }
                let destination = blobURL(sha)
                let replaced = fm.fileExists(atPath: destination.path) ? try Self.metadata(destination) : nil
                let temp = rootURL.appendingPathComponent(".blob-\(UUID().uuidString)")
                defer { try? fm.removeItem(at: temp) }
                guard fm.createFile(atPath: temp.path, contents: nil) else { throw BoardBackupError.changed }
                let input = try FileHandle(forReadingFrom: safeURL), output = try FileHandle(forWritingTo: temp)
                defer { try? input.close(); try? output.close() }
                var hash = SHA256(), count: UInt64 = 0
                while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
                    try Task.checkCancellation(); count += UInt64(data.count)
                    guard count <= settings.policy.maximumAssetBytes, count <= before.size,
                          used + count <= settings.policy.maximumBytes else { throw BoardBackupError.limit }
                    hash.update(data: data); try output.write(contentsOf: data)
#if INKSPACE_BACKUP_TESTING
                    captureObserver?(.assetBytesWritten(path, data.count))
#endif
                }
                try Task.checkCancellation()
                let writtenSHA = hash.finalize().map { String(format: "%02x", $0) }.joined()
                guard count == before.size, writtenSHA == sha,
                      try Self.metadata(safeURL).stamp == before.stamp else { throw BoardBackupError.changed }
                try output.synchronize(); try output.close()
                // Verify the staged bytes as well as the two source reads. Replace
                // a corrupt blob only after its replacement is complete and checked.
                guard try Self.hashFile(temp, maximumBytes: settings.policy.maximumAssetBytes) == sha,
                      try Self.metadata(safeURL).stamp == before.stamp else { throw BoardBackupError.changed }
                try Task.checkCancellation()
                if let replaced {
                    guard try Self.metadata(destination).stamp == replaced.stamp else { throw BoardBackupError.changed }
                    _ = try fm.replaceItemAt(destination, withItemAt: temp)
                    used = used - min(used, replaced.size) + count
                } else {
                    guard !fm.fileExists(atPath: destination.path) else { throw BoardBackupError.changed }
                    try fm.moveItem(at: temp, to: destination); used += count
                }
                return .init(path: path, sha256: sha, bytes: count, stamp: before.stamp)
            }
        }
        if let coordinationError { throw coordinationError }
        return try result?.get() ?? { throw BoardBackupError.changed }()
    }
    private func hasVerifiedBlob(sha: String, bytes: UInt64) throws -> Bool {
        let url = blobURL(sha)
        guard fm.fileExists(atPath: url.path) else { return false }
        let info = try Self.metadata(url)
        guard info.size == bytes else { return false }
        return try Self.hashFile(url, maximumBytes: settings.policy.maximumAssetBytes) == sha
    }
    private static func metadata(_ url: URL) throws -> (stamp: String, size: UInt64) {
        let v = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey, .contentModificationDateKey, .fileResourceIdentifierKey, .ubiquitousItemDownloadingStatusKey])
        guard v.isRegularFile == true, v.isSymbolicLink != true, let size = v.fileSize, size >= 0 else { throw BoardBackupError.unsafePath }
        if let status = v.ubiquitousItemDownloadingStatus, status == .notDownloaded { throw BoardBackupError.incomplete }
        return ("\(size)|\(v.contentModificationDate?.timeIntervalSince1970 ?? -1)|\(String(describing: v.fileResourceIdentifier))", UInt64(size))
    }
    static func resolve(_ path: String, under root: URL) throws -> URL {
        guard VaultPath.isSafeRelative(path) else { throw BoardBackupError.unsafePath }
        var candidate = root.standardizedFileURL.resolvingSymlinksInPath()
        for component in path.split(separator: "/") {
            candidate.appendPathComponent(String(component))
            let values = try candidate.resourceValues(forKeys: [.isSymbolicLinkKey])
            guard values.isSymbolicLink != true else { throw BoardBackupError.unsafePath }
        }
        return candidate
    }
    private func publish(record: BoardBackupRecord, board: Data, scope: String, generation: UInt64) throws {
        let directory = boardDirectory(scope).appendingPathComponent("versions")
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        let stage = directory.appendingPathComponent(".pending-\(record.id.uuidString)"), final = directory.appendingPathComponent(record.id.uuidString)
        try fm.createDirectory(at: stage, withIntermediateDirectories: false)
        defer { try? fm.removeItem(at: stage) }
        try board.write(to: stage.appendingPathComponent("board.json"), options: .atomic)
        try JSONEncoder().encode(record).write(to: stage.appendingPathComponent("manifest.json"), options: .atomic)
        try Task.checkCancellation(); try fm.moveItem(at: stage, to: final)
        var index = try readIndex(scope)
        if generation >= (newestGeneration[scope] ?? 0) { index.checkpoint = record.id }
        if record.complete, generation >= (newestCompleteGeneration[scope] ?? 0) {
            index.latestComplete = record.id; newestCompleteGeneration[scope] = generation
        }
        if record.reason != .checkpoint { index.history.insert(record.id, at: 0); index.history = Array(index.history.prefix(settings.policy.sessionCount)) }
        try JSONEncoder().encode(index).write(to: boardDirectory(scope).appendingPathComponent("index.json"), options: .atomic)
        try? collectGarbage()
    }
    func records(scope: String) throws -> [BoardBackupRecord] {
        let index = try readIndex(scope)
        let ids = Set(index.history + [index.checkpoint, index.latestComplete].compactMap { $0 })
        return try ids.map { try readRecord(scope, $0) }.sorted { $0.date > $1.date }
    }
    private func boardDirectory(_ scope: String) -> URL { rootURL.appendingPathComponent("boards/" + scope) }
    private func versionDirectory(_ scope: String, _ id: UUID) -> URL { boardDirectory(scope).appendingPathComponent("versions/" + id.uuidString) }
    private func readIndex(_ scope: String) throws -> Index {
        guard Self.isSHA(scope) else { throw BoardBackupError.unsafePath }
        let url = boardDirectory(scope).appendingPathComponent("index.json")
        return fm.fileExists(atPath: url.path) ? try JSONDecoder().decode(Index.self, from: Data(contentsOf: url)) : Index()
    }
    private func readRecord(_ scope: String, _ id: UUID) throws -> BoardBackupRecord {
        let data = try Self.readData(versionDirectory(scope, id).appendingPathComponent("manifest.json"), maximumBytes: 8 * 1024 * 1024)
        guard data.count <= 8 * 1024 * 1024 else { throw BoardBackupError.limit }
        let record = try JSONDecoder().decode(BoardBackupRecord.self, from: data)
        try validate(record); return record
    }
    private func blobURL(_ sha: String) -> URL { rootURL.appendingPathComponent("blobs/" + sha) }
    static func isSHA(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    private func validate(_ record: BoardBackupRecord) throws {
        guard record.version == 1, Self.isSHA(record.boardSHA256), Self.isSHA(record.contentSHA256), record.assets.count <= 10000,
              Set(record.assets.map { $0.path.precomposedStringWithCanonicalMapping.lowercased() }).count == record.assets.count,
              record.assets.allSatisfy({ VaultPath.isSafeRelative($0.path) && Self.isSHA($0.sha256) && $0.bytes <= settings.policy.maximumAssetBytes }),
              record.missing.allSatisfy({ VaultPath.isSafeRelative($0.path) }),
              !record.complete || (!record.editableOnly && record.missing.isEmpty) else { throw BoardBackupError.corrupt }
        if let path = record.writingAidTapePath {
            guard path == Self.tapePath(boardID: record.boardID),
                  let asset = record.assets.first(where: { $0.path == path }),
                  asset.bytes <= UInt64(BoardWritingAidTapeDocument.maximumBytes) else { throw BoardBackupError.corrupt }
        }
    }
    private func storageBytes() throws -> UInt64 {
        guard let files = fm.enumerator(at: rootURL, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey]) else { return 0 }
        var total: UInt64 = 0
        for case let file as URL in files {
            let v = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            if v.isRegularFile == true { total += UInt64(v.fileSize ?? 0) }
        }
        return total
    }
    func usageBytes() throws -> UInt64 { try storageBytes() }
    private func collectGarbage() throws {
        var usedBlobs = Set<String>()
        for scopeURL in try fm.contentsOfDirectory(at: rootURL.appendingPathComponent("boards"), includingPropertiesForKeys: nil) {
            let scope = scopeURL.lastPathComponent; guard Self.isSHA(scope) else { continue }
            let index = try readIndex(scope), ids = Set(index.history + [index.checkpoint, index.latestComplete].compactMap { $0 })
            for id in ids { usedBlobs.formUnion(try readRecord(scope, id).assets.map(\.sha256)) }
            let versions = scopeURL.appendingPathComponent("versions")
            for url in (try? fm.contentsOfDirectory(at: versions, includingPropertiesForKeys: nil)) ?? [] {
                if let id = UUID(uuidString: url.lastPathComponent), !ids.contains(id) { try fm.removeItem(at: url) }
            }
        }
        for url in try fm.contentsOfDirectory(at: rootURL.appendingPathComponent("blobs"), includingPropertiesForKeys: nil) {
            if Self.isSHA(url.lastPathComponent), !usedBlobs.contains(url.lastPathComponent) { try fm.removeItem(at: url) }
        }
    }
    func deleteHistory(scope: String, id: UUID) throws {
        var index = try readIndex(scope)
        guard index.checkpoint != id, index.latestComplete != id else { throw BoardBackupError.incomplete }
        index.history.removeAll { $0 == id }
        try JSONEncoder().encode(index).write(to: boardDirectory(scope).appendingPathComponent("index.json"), options: .atomic)
        try collectGarbage()
    }
    private func verifiedAsset(_ asset: BoardBackupAsset) throws -> URL {
        let url = blobURL(asset.sha256)
        guard try Self.hashFile(url, maximumBytes: settings.policy.maximumAssetBytes) == asset.sha256 else { throw BoardBackupError.corrupt }
        return url
    }
    static func readData(_ url: URL, maximumBytes: UInt64) throws -> Data {
        let before = try metadata(url); guard before.size <= maximumBytes else { throw BoardBackupError.limit }
        let input = try FileHandle(forReadingFrom: url); defer { try? input.close() }
        var result = Data()
        while let part = try input.read(upToCount: 1024 * 1024), !part.isEmpty {
            try Task.checkCancellation()
            guard UInt64(result.count) + UInt64(part.count) <= maximumBytes else { throw BoardBackupError.limit }
            result.append(part)
        }
        guard UInt64(result.count) == before.size, try metadata(url).stamp == before.stamp else { throw BoardBackupError.changed }
        return result
    }
    static func hashFile(_ url: URL, maximumBytes: UInt64) throws -> String {
        let before = try metadata(url); guard before.size <= maximumBytes else { throw BoardBackupError.limit }
        let input = try FileHandle(forReadingFrom: url); defer { try? input.close() }
        var hash = SHA256(), count: UInt64 = 0
        while let data = try input.read(upToCount: 1024 * 1024), !data.isEmpty {
            try Task.checkCancellation(); count += UInt64(data.count); guard count <= maximumBytes else { throw BoardBackupError.limit }; hash.update(data: data)
        }
        guard count == before.size, try metadata(url).stamp == before.stamp else { throw BoardBackupError.changed }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    func export(scope: String, id: UUID) throws -> URL {
        let record = try readRecord(scope, id)
        _ = try verifiedTape(record: record)
        let directory = versionDirectory(scope, id), boardURL = directory.appendingPathComponent("board.json")
        guard try Self.hashFile(boardURL, maximumBytes: UInt64(Self.maximumBoardBytes)) == record.boardSHA256 else { throw BoardBackupError.corrupt }
        var entries = [(name: "manifest.json", url: directory.appendingPathComponent("manifest.json")), (name: "board.json", url: boardURL)]
        var seen = Set<String>()
        for asset in record.assets where seen.insert(asset.sha256).inserted { entries.append(("assets/" + asset.sha256, try verifiedAsset(asset))) }
        let output = fm.temporaryDirectory.appendingPathComponent("人生赢家备份-\(UUID().uuidString).zip")
        try BackupArchive.write(entries: entries, to: output, maximumBytes: settings.policy.maximumBytes)
        return output
    }
    /// Imports a verified portable package into local history. Never reads a vault.
    func importArchive(_ archive: URL) throws -> (scope: String, record: BoardBackupRecord) {
        var committed = false
        defer { if !committed { try? collectGarbage() } }
        let extracted = fm.temporaryDirectory.appendingPathComponent("backup-import-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: extracted) }
        let names = try BackupArchive.extract(archive, to: extracted, maximumBytes: settings.policy.maximumBytes)
        let manifest = try Self.readData(extracted.appendingPathComponent("manifest.json"), maximumBytes: 8 * 1024 * 1024)
        guard manifest.count <= 8 * 1024 * 1024 else { throw BoardBackupError.limit }
        var record = try JSONDecoder().decode(BoardBackupRecord.self, from: manifest); try validate(record)
        let expected = Set(["manifest.json", "board.json"] + record.assets.map { "assets/" + $0.sha256 })
        guard Set(names) == expected else { throw BoardBackupError.corrupt }
        let board = try Self.readData(extracted.appendingPathComponent("board.json"), maximumBytes: UInt64(Self.maximumBoardBytes))
        guard board.count <= Self.maximumBoardBytes, Self.digest(board) == record.boardSHA256 else { throw BoardBackupError.corrupt }
        let document = try BoardDocument.decode(board); guard document.id == record.boardID else { throw BoardBackupError.corrupt }
        let referenced = Set(document.items.flatMap { [$0.sourcePath, $0.originalSourcePath].compactMap { $0 } }).union(document.pdfOwnedSourcePaths ?? [])
        guard !record.complete || referenced.isSubset(of: Set(record.assets.map(\.path))) else { throw BoardBackupError.corrupt }
        var used = try storageBytes(), seen = Set<String>()
        for asset in record.assets where seen.insert(asset.sha256).inserted {
            let url = extracted.appendingPathComponent("assets/" + asset.sha256)
            guard try Self.hashFile(url, maximumBytes: settings.policy.maximumAssetBytes) == asset.sha256,
                  (try Self.metadata(url)).size == asset.bytes else { throw BoardBackupError.corrupt }
            if !fm.fileExists(atPath: blobURL(asset.sha256).path) {
                used += asset.bytes; guard used + UInt64(board.count) + 1024 * 1024 <= settings.policy.maximumBytes else { throw BoardBackupError.limit }
                try fm.copyItem(at: url, to: blobURL(asset.sha256))
            }
        }
        _ = try verifiedTape(record: record)
        let scope = Self.digest(Data(("import:" + record.boardID.uuidString).utf8))
        record.id = UUID(); record.date = Date(); record.reason = .manual
        try publish(record: record, board: board, scope: scope, generation: 0)
        committed = true
        return (scope, record)
    }
    /// Complete-only restore is deliberately conservative. Missing-asset journals
    /// remain exportable/editable but cannot silently produce dangling originals.
    func restore(scope: String, id: UUID, vaultURL: URL, directoryPath: String, allowIncomplete: Bool = false) throws -> String {
        let record = try readRecord(scope, id); guard record.complete || allowIncomplete else { throw BoardBackupError.incomplete }
        let boardBytes = try Self.readData(versionDirectory(scope, id).appendingPathComponent("board.json"), maximumBytes: UInt64(Self.maximumBoardBytes))
        guard Self.digest(boardBytes) == record.boardSHA256 else { throw BoardBackupError.corrupt }
        var document = try BoardDocument.decode(boardBytes)
        var restoredTape = try verifiedTape(record: record)
        let access = vaultURL.startAccessingSecurityScopedResource(); defer { if access { vaultURL.stopAccessingSecurityScopedResource() } }
        let parent = directoryPath.isEmpty ? vaultURL.standardizedFileURL.resolvingSymlinksInPath() : try Self.resolve(directoryPath, under: vaultURL)
        guard (try parent.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true else { throw BoardBackupError.unsafePath }
        let folder = "人生赢家恢复-" + UUID().uuidString, prefix = directoryPath.isEmpty ? folder : directoryPath + "/" + folder
        let stage = parent.appendingPathComponent(".backup-restore-" + UUID().uuidString), final = parent.appendingPathComponent(folder)
        try fm.createDirectory(at: stage, withIntermediateDirectories: false); defer { try? fm.removeItem(at: stage) }
        var mapping: [String: String] = [:], sourceHashes: [String: String] = [:]
        let pdfPaths = originalPDFPaths(document)
        for asset in record.assets where asset.path != record.writingAidTapePath {
            try Task.checkCancellation(); let original = try verifiedAsset(asset)
            let relative = "Sources/" + asset.path, target = stage.appendingPathComponent(relative)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if pdfPaths.contains(asset.path) {
                let bytes = try Data(contentsOf: original)
                let clean = try BackupPDFSanitizer.removingOwnedInk(bytes, boardIDs: document.pdfDisplayOwnerIDs)
                try clean.write(to: target, options: .atomic)
            } else if ["md", "markdown"].contains((asset.path as NSString).pathExtension.lowercased()) {
                let source = try String(contentsOf: original, encoding: .utf8)
                let restored = try BackupMarkdownReferences.relocateRootImages(in: source, sourcePath: asset.path, prefix: prefix + "/Sources/")
                try Data(restored.utf8).write(to: target, options: .atomic)
            } else { try fm.copyItem(at: original, to: target) }
            mapping[asset.path] = prefix + "/" + relative
            sourceHashes[asset.path] = try Self.hashFile(target, maximumBytes: settings.policy.maximumAssetBytes)
        }
        for index in document.items.indices {
            if let source = document.items[index].sourcePath { let new = mapping[source] ?? (prefix + "/Sources/" + source); document.items[index].sourcePath = new }
            if let source = document.items[index].originalSourcePath {
                let new = mapping[source] ?? (prefix + "/Sources/" + source)
                document.items[index].originalSourcePath = new; document.items[index].originalSourceSHA256 = sourceHashes[source]
            }
        }
        document.id = UUID(); document.writerID = UUID(); document.revision = 0; document.createdAt = Date(); document.updatedAt = document.createdAt
        restoredTape?.boardID = document.id; restoredTape?.revision = 0
        document.title += "（恢复副本）"; document.pdfAnnotationSources = nil; document.pdfOwnedSourcePaths = nil; document.pdfWritebackSuspended = !record.complete
        document.pdfMergedOwnerIDs = nil // Restored PDFs have already removed every inherited owner.
        let boardName = "恢复白板.inkspace.json", boardPath = prefix + "/" + boardName
        try document.encode().write(to: stage.appendingPathComponent(boardName), options: .atomic)
        let json = String(data: try JSONSerialization.data(withJSONObject: ["file": boardPath], options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
        let wrapper = "%% InkSpace board: \(document.id.uuidString) %%\n\n```inkspace\n\(json)\n```\n"
        try Data(wrapper.utf8).write(to: stage.appendingPathComponent("恢复白板.md"), options: .atomic)
        try Task.checkCancellation()
        var error: NSError?, result: Result<Void, Error>?
#if INKSPACE_BACKUP_TESTING
        captureObserver?(.restorePrepared(document.id, final))
#endif
        if let restoredTape {
            // Publish both new identities under one coordinated operation. The
            // sidecar is never written over an existing file, even on collision.
            let tapeURL = try Self.restoreTapeURL(boardID: document.id, root: vaultURL)
            let stagedTape = stage.appendingPathComponent(".restored-writing-aid.json")
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(restoredTape).write(to: stagedTape, options: .atomic)
            NSFileCoordinator().coordinate(writingItemAt: final, options: .forReplacing,
                writingItemAt: tapeURL, options: .forReplacing, error: &error) { destination, tapeDestination in
                result = Result {
                    try Self.requireAbsent(destination); try Self.requireAbsent(tapeDestination)
                    try fm.moveItem(at: stagedTape, to: tapeDestination)
                    let stamp = try Self.metadata(tapeDestination).stamp
#if INKSPACE_BACKUP_TESTING
                    captureObserver?(.restoreTapePublished(document.id, destination))
#endif
                    do { try fm.moveItem(at: stage, to: destination) }
                    catch {
                        // Remove only our unchanged, newly published companion.
                        // External changes are preserved rather than rolled back.
                        if (try? Self.metadata(tapeDestination).stamp) == stamp { try? fm.removeItem(at: tapeDestination) }
                        throw error
                    }
                }
            }
        } else {
            NSFileCoordinator().coordinate(writingItemAt: final, options: .forReplacing, error: &error) { destination in
                result = Result { try Self.requireAbsent(destination); try fm.moveItem(at: stage, to: destination) }
            }
        }
        if let error { throw error }; try result?.get(); guard result != nil else { throw BoardBackupError.changed }
        return boardPath
    }

    private static func tapePath(boardID: UUID) -> String {
        ".inkspace/writing-aids/" + boardID.uuidString.lowercased() + ".json"
    }
    private static func isMissingFile(_ error: Error) -> Bool {
        let value = error as NSError
        return value.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(value.code)
    }
    private static func requireAbsent(_ url: URL) throws {
        do { _ = try FileManager.default.attributesOfItem(atPath: url.path) }
        catch { if isMissingFile(error) { return }; throw error }
        throw BoardBackupError.changed
    }
    private static func optionalTapeURL(boardID: UUID, root: URL) throws -> URL? {
        // A missing companion is normal; an existing symlink, placeholder or
        // malformed file is an error and must not masquerade as missing tape.
        guard let directory = try tapeDirectory(root: root, create: false) else { return nil }
        let url = directory.appendingPathComponent(boardID.uuidString.lowercased() + ".json")
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { throw BoardBackupError.unsafePath }
            return url
        } catch { if isMissingFile(error) { return nil }; throw error }
    }
    private static func restoreTapeURL(boardID: UUID, root: URL) throws -> URL {
        guard let directory = try tapeDirectory(root: root, create: true) else { throw BoardBackupError.unsafePath }
        return directory.appendingPathComponent(boardID.uuidString.lowercased() + ".json")
    }
    private static func tapeDirectory(root: URL, create: Bool) throws -> URL? {
        guard root.isFileURL else { throw BoardBackupError.unsafePath }
        var directory = root.standardizedFileURL
        let rootValues = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else { throw BoardBackupError.unsafePath }
        for name in [".inkspace", "writing-aids"] {
            directory.appendPathComponent(name, isDirectory: true)
            do {
                let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard values.isDirectory == true, values.isSymbolicLink != true else { throw BoardBackupError.unsafePath }
            } catch {
                guard isMissingFile(error) else { throw error }
                guard create else { return nil }
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard values.isDirectory == true, values.isSymbolicLink != true else { throw BoardBackupError.unsafePath }
            }
        }
        return directory
    }
    private func verifiedTape(record: BoardBackupRecord) throws -> BoardWritingAidTapeDocument? {
        guard let path = record.writingAidTapePath,
              let asset = record.assets.first(where: { $0.path == path }) else { return nil }
        return try verifiedTape(asset: asset, boardID: record.boardID)
    }
    private func verifiedTape(asset: BoardBackupAsset, boardID: UUID) throws -> BoardWritingAidTapeDocument {
        guard asset.bytes <= UInt64(BoardWritingAidTapeDocument.maximumBytes) else { throw BoardBackupError.limit }
        let bytes = try Self.readData(verifiedAsset(asset), maximumBytes: UInt64(BoardWritingAidTapeDocument.maximumBytes))
        let value = try JSONDecoder().decode(BoardWritingAidTapeDocument.self, from: bytes)
        guard value.boardID == boardID else { throw BoardWritingAidFailure.wrongBoard }
        try value.validate()
        return value
    }
    private func originalPDFPaths(_ document: BoardDocument) -> Set<String> {
        Set(document.items.compactMap { item in item.sourcePath.flatMap { ($0 as NSString).pathExtension.lowercased() == "pdf" ? $0 : nil } })
            .union(document.pdfOwnedSourcePaths ?? [])
    }
}
