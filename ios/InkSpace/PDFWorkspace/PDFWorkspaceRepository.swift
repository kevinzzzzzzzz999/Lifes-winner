import Foundation
import CryptoKit
import Darwin

/// Cloud placeholders must be materialized before POSIX reads. Poll on the
/// repository worker, never the main actor; no document contents are changed.
enum PDFCloudFilePreparation {
    enum Failure: LocalizedError {
        case timedOut, download(String)
        var errorDescription: String? {
            switch self {
            case .timedOut: String(localized: "云端文件尚未下载完成，请稍后点 PDF 标题旁的刷新重试。")
            case .download(let message): String(localized: "暂时无法下载云端文件：\(message)。请稍后刷新重试。")
            }
        }
    }
    static func waitUntilReadable(_ url: URL, checkCancellation: () throws -> Void,
                                  needsDownload: (URL) throws -> Bool = cloudNeedsDownload,
                                  requestDownload: (URL) throws -> Void = { try FileManager.default.startDownloadingUbiquitousItem(at: $0) },
                                  now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                                  wait: () -> Void = { Thread.sleep(forTimeInterval: 0.1) },
                                  timeout: TimeInterval = 20) throws {
        try checkCancellation()
        let deadline = now() + timeout
        do {
            guard try needsDownload(url) else { return }
            try checkCancellation(); try requestDownload(url)
            while true {
                try checkCancellation()
                if try !needsDownload(url) { try checkCancellation(); return }
                guard now() < deadline else { throw Failure.timedOut }
                wait()
            }
        } catch is CancellationError { throw CancellationError() }
        catch let error as Failure { throw error }
        catch { throw Failure.download(error.localizedDescription) }
    }
    private static func cloudNeedsDownload(_ url: URL) throws -> Bool {
        var fresh = url; fresh.removeAllCachedResourceValues()
        let values = try fresh.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
        return values.isUbiquitousItem == true && values.ubiquitousItemDownloadingStatus != .current && values.ubiquitousItemDownloadingStatus != .downloaded
    }
}

/// A provider or POSIX read may outlive cancellation. Resume the UI exactly
/// once at the deadline; late worker completion is ignored safely.
final class PDFRepositoryCompletion<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var resolved = false
    private var deadline: DispatchWorkItem?
    private let resolve: (Result<Value, Error>) -> Void
    init(_ resolve: @escaping (Result<Value, Error>) -> Void) { self.resolve = resolve }
    func installDeadline(_ item: DispatchWorkItem) {
        lock.lock(); let finished = resolved; if !finished { deadline = item }; lock.unlock()
        if finished { item.cancel() }
    }
    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard !resolved else { lock.unlock(); return }
        resolved = true; let deadline = self.deadline; self.deadline = nil
        lock.unlock(); deadline?.cancel(); resolve(result)
    }
}

struct PDFWorkspaceSnapshot: Sendable {
    var sourceURL: URL
    var sourceSHA256: String
    var records: [PDFWorkspaceEvent]
    var projection: PDFWorkspaceProjection
}
private final class PDFWorkspaceIOControl: @unchecked Sendable {
    let lock = NSLock()
    var cancelled = false
    var coordinator: NSFileCoordinator?
    private var cancellationHandler: (() -> Void)?
    func onCancellation(_ action: @escaping () -> Void) { lock.lock(); cancellationHandler = action; let stop = cancelled; lock.unlock(); if stop { action() } }
    func check() throws { lock.lock(); let value = cancelled; lock.unlock(); if value { throw CancellationError() } }
    func use(_ value: NSFileCoordinator) throws { lock.lock(); coordinator = value; let stop = cancelled; lock.unlock(); if stop { value.cancel(); throw CancellationError() } }
    func cancel() { lock.lock(); cancelled = true; let current = coordinator, handler = cancellationHandler; lock.unlock(); handler?(); current?.cancel() }
}
private final class PDFWorkspaceScope {
    let url: URL
    let acquired: Bool
    init(_ url: URL) { self.url = url; acquired = url.startAccessingSecurityScopedResource() }
    deinit { if acquired { url.stopAccessingSecurityScopedResource() } }
}

/// All filesystem work, hashing and coordination are on a private worker. Only
/// immutable event JSON is published; source PDF and board files stay read-only.
final class PDFWorkspaceRepository: @unchecked Sendable {
    static let maximumEntries = 20000
    static let maximumBytes = 64 * 1024 * 1024
    static let maximumPDFBytes = 256 * 1024 * 1024
    private let queue = DispatchQueue(label: "InkSpace.pdf-workspace", qos: .userInitiated)
    let rootURL: URL?
    let sourceURL: URL
    private let backupDirectory: URL
    private var cachedFingerprint: String?
    private var cachedSHA256: String?
    init(rootURL: URL?, sourceURL: URL, backupDirectory: URL? = nil) {
        self.rootURL = rootURL; self.sourceURL = sourceURL
        self.backupDirectory = backupDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("InkSpace/PDFLayerRecovery", isDirectory: true)
    }
    static func sidecarURL(for source: URL) -> URL { source.deletingLastPathComponent().appendingPathComponent("." + source.lastPathComponent + ".inkspace-pdf", isDirectory: true) }
    func load() async throws -> PDFWorkspaceSnapshot {
        try await perform { control in
            try self.coordinated(writing: false, control: control) { source in
                let hash = try self.sourceHash(source, control: control), scan = try self.scan(Self.sidecarURL(for: source), control: control)
                return PDFWorkspaceSnapshot(sourceURL: source, sourceSHA256: hash, records: scan.events, projection: .project(scan.events, warnings: scan.warnings))
            }
        }
    }
    func readPDF(expectedSHA256: String) async throws -> Data {
        try await perform { control in
            try self.coordinated(writing: false, control: control) { source in
                guard try self.sourceHash(source, control: control) == expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                let data = try Self.readRegular(source, limit: Self.maximumPDFBytes, control: control)
                guard Self.digest(data) == expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                return data
            }
        }
    }
    func validateSource(expectedSHA256: String) async throws {
        try await perform { control in
            try self.coordinated(writing: false, control: control) { source in
                guard try self.sourceHash(source, control: control) == expectedSHA256 else { throw PDFWorkspaceError.staleSource }
            }
        }
    }
    /// Exact IDs make retries idempotent, including a partially published batch.
    /// Recovery copies are persisted before any new event becomes visible.
    func publish(_ events: [PDFWorkspaceEvent], expectedSHA256: String) async throws -> PDFWorkspaceSnapshot {
        guard rootURL != nil else { throw PDFWorkspaceError.unsafePath }
        guard !events.isEmpty, events.count <= 512 else { throw PDFWorkspaceError.tooLarge }
        let validated = try events.map { try PDFWorkspaceEvent.decodeValidated($0.encoded()) }
        let encoded = try validated.map { try $0.encoded() }
        return try await perform(readOnly: false) { control in
            try self.coordinated(writing: true, control: control) { source in
                guard try self.sourceHash(source, control: control) == expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                let directory = Self.sidecarURL(for: source)
                let scan = try self.scan(directory, control: control)
                var merged = scan.events, published: [UUID: Data] = [:]
                for event in scan.events { published[event.id] = try event.encoded() }
                var newEvents: [(PDFWorkspaceEvent,Data)] = []
                for (event,data) in zip(validated, encoded) {
                    if let existing = published[event.id] {
                        guard existing == data else { throw PDFWorkspaceError.invalidRecord }; continue
                    }
                    let current = PDFWorkspaceProjection.project(merged)
                    switch event.kind {
                    case .annotation:
                        guard let mark = event.annotation,
                              !merged.contains(where: { $0.kind == .deleteAnnotation && $0.targetID == mark.id }),
                              (mark.sourceSHA256 == expectedSHA256 || merged.contains(where: { prior in
                                  guard var old = prior.annotation else { return false }; old.id = mark.id; old.layerID = mark.layerID; return old == mark
                              })),
                              let layer = current.layers.first(where: { $0.id == mark.layerID }), layer.visible && !layer.locked else { throw PDFWorkspaceError.lockedLayer }
                    case .layer:
                        if merged.contains(where: { $0.kind == .deleteLayer && $0.targetID == event.layer?.id }) { throw PDFWorkspaceError.lockedLayer }
                    case .deleteAnnotation:
                        if let mark = current.annotations.first(where: { $0.id == event.targetID }),
                           let layer = current.layers.first(where: { $0.id == mark.layerID }), layer.locked || !layer.visible { throw PDFWorkspaceError.lockedLayer }
                    case .deleteLayer:
                        if current.layers.first(where: { $0.id == event.targetID })?.locked == true { throw PDFWorkspaceError.lockedLayer }
                    }
                    newEvents.append((event,data)); merged.append(event); published[event.id] = data
                }
                guard scan.entries + newEvents.count <= Self.maximumEntries,
                      scan.bytes + newEvents.reduce(0, { $0 + $1.1.count }) <= Self.maximumBytes else { throw PDFWorkspaceError.tooLarge }
                let recovery = self.backupDirectory.appendingPathComponent(Self.digest(Data(source.path.utf8)), isDirectory: true)
                do {
                    try FileManager.default.createDirectory(at: recovery, withIntermediateDirectories: true)
                    for (event,data) in newEvents {
                        let target = recovery.appendingPathComponent(event.id.uuidString.lowercased() + ".json")
                        if FileManager.default.fileExists(atPath: target.path) { guard try Self.readRegular(target, limit: PDFWorkspaceEvent.maximumBytes, control: control) == data else { throw PDFWorkspaceError.backupFailed } }
                        else { try Self.writeNew(data, to: target) }
                    }
                } catch { throw PDFWorkspaceError.backupFailed }
                try control.check()
                if !FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false) }
                try Self.requireDirectory(directory)
                guard try self.sourceHash(source, control: control) == expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                for (event,data) in newEvents {
                    try control.check()
                    let target = directory.appendingPathComponent(event.id.uuidString.lowercased() + ".json")
                    do { try Self.writeNew(data, to: target) }
                    catch {
                        // Another writer may have published this same retry ID.
                        guard (try? Self.readRegular(target, limit: PDFWorkspaceEvent.maximumBytes, control: control)) == data else { throw error }
                    }
                }
                guard try self.sourceHash(source, control: control) == expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                return PDFWorkspaceSnapshot(sourceURL: source, sourceSHA256: expectedSHA256, records: merged, projection: .project(merged, warnings: scan.warnings))
            }
        }
    }
    private func perform<T>(readOnly: Bool = true, _ body: @escaping (PDFWorkspaceIOControl) throws -> T) async throws -> T {
        let control = PDFWorkspaceIOControl()
        return try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let completion = PDFRepositoryCompletion<T> { continuation.resume(with: $0) }
                // Publication/asset writes must report their actual worker
                // outcome, never return while a visible write may still finish.
                if readOnly { control.onCancellation { completion.finish(.failure(CancellationError())) } }
                let timeout = DispatchWorkItem {
                    if readOnly { completion.finish(.failure(PDFCloudFilePreparation.Failure.timedOut)) }
                    control.cancel()
                }
                // Start before queueing: a previous provider read may still be
                // unwinding, and must not leave the next reader busy forever.
                completion.installDeadline(timeout)
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 25, execute: timeout)
                queue.async {
                    completion.finish(Result { try control.check(); return try body(control) })
                }
            }
        }, onCancel: { control.cancel() })
    }
    private func coordinated<T>(writing: Bool, control: PDFWorkspaceIOControl, body: (URL) throws -> T) throws -> T {
        let scope = PDFWorkspaceScope(rootURL ?? sourceURL); defer { withExtendedLifetime(scope) {} }
        let source = try resolvedSource(), parent = source.deletingLastPathComponent()
        try PDFCloudFilePreparation.waitUntilReadable(source, checkCancellation: control.check)
        let coordinator = NSFileCoordinator(); try control.use(coordinator)
        var error: NSError?, result: Result<T,Error>?
        func access(_ accessed: URL) {
            result = Result {
                try control.check()
                guard accessed.standardizedFileURL == source.standardizedFileURL, try resolvedSource() == source else { throw PDFWorkspaceError.unsafePath }
                return try body(source)
            }
        }
        if writing {
            coordinator.coordinate(readingItemAt: source, options: [], writingItemAt: parent, options: .forMerging, error: &error) { readable, writable in
                guard writable.standardizedFileURL == parent.standardizedFileURL else { result = .failure(PDFWorkspaceError.unsafePath); return }
                access(readable)
            }
        } else { coordinator.coordinate(readingItemAt: source, options: [], error: &error, byAccessor: access) }
        try control.check()
        if let error { throw error }
        guard let result else { throw PDFWorkspaceError.unavailable }
        return try result.get()
    }
    private func resolvedSource() throws -> URL {
        guard sourceURL.isFileURL, sourceURL.pathExtension.lowercased() == "pdf" else { throw PDFWorkspaceError.unsafePath }
        guard let rootURL else {
            let source = sourceURL.standardizedFileURL
            _ = try Self.stamp(source, regular: true, limit: Self.maximumPDFBytes); return source
        }
        let originalRoot = rootURL.standardizedFileURL, root = originalRoot.resolvingSymlinksInPath(), input = sourceURL.standardizedFileURL
        let prefix = input.pathComponents.starts(with: originalRoot.pathComponents) ? originalRoot.pathComponents : root.pathComponents
        guard input.pathComponents.starts(with: prefix), input.pathComponents.count > prefix.count else { throw PDFWorkspaceError.unsafePath }
        let suffix = input.pathComponents.dropFirst(prefix.count)
        var current = root; try Self.requireDirectory(current)
        for (index, component) in suffix.enumerated() {
            guard component != ".", component != "..", !component.isEmpty, !component.contains("\\"), !component.contains(":"),
                  !component.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw PDFWorkspaceError.unsafePath }
            current.appendPathComponent(component)
            if index == suffix.count - 1 { _ = try Self.stamp(current, regular: true, limit: Self.maximumPDFBytes) }
            else { try Self.requireDirectory(current) }
        }
        return current
    }
    private struct Scan { var events: [PDFWorkspaceEvent] = []; var warnings: [String] = []; var entries = 0; var bytes = 0 }
    private func scan(_ directory: URL, control: PDFWorkspaceIOControl) throws -> Scan {
        var result = Scan(), invalid = 0
        if !FileManager.default.fileExists(atPath: directory.path) {
            var value = stat(); if lstat(directory.path, &value) == 0 { throw PDFWorkspaceError.unsafePath }
            if errno == ENOENT { return result }; throw PDFWorkspaceError.unavailable
        }
        try Self.requireDirectory(directory)
        guard let iterator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil, options: [.skipsSubdirectoryDescendants]) else { throw PDFWorkspaceError.unavailable }
        for case let url as URL in iterator {
            try control.check(); result.entries += 1
            guard result.entries <= Self.maximumEntries else { throw PDFWorkspaceError.tooLarge }
            do {
                let stamp = try Self.stamp(url, regular: true, limit: Self.maximumBytes)
                result.bytes += Int(stamp.st_size)
                guard result.bytes <= Self.maximumBytes else { throw PDFWorkspaceError.tooLarge }
                guard stamp.st_size <= PDFWorkspaceEvent.maximumBytes else { invalid += 1; continue }
                let data = try Self.readRegular(url, limit: PDFWorkspaceEvent.maximumBytes, control: control)
                let event = try PDFWorkspaceEvent.decodeValidated(data)
                guard url.lastPathComponent == event.id.uuidString.lowercased() + ".json" else { throw PDFWorkspaceError.invalidRecord }
                result.events.append(event)
            } catch PDFWorkspaceError.tooLarge { throw PDFWorkspaceError.tooLarge }
            catch is CancellationError { throw CancellationError() }
            catch let error as PDFCloudFilePreparation.Failure { throw error }
            catch { invalid += 1 }
        }
        if invalid > 0 { result.warnings = [String(localized: "有 \(invalid) 条 PDF 图层记录暂无法读取；原记录保持不变。")] }
        return result
    }
    private func sourceHash(_ source: URL, control: PDFWorkspaceIOControl) throws -> String {
        let before = try Self.stamp(source, regular: true, limit: Self.maximumPDFBytes), fingerprint = Self.fingerprint(before)
        if cachedFingerprint == fingerprint, let cachedSHA256 { return cachedSHA256 }
        let descriptor = open(source.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PDFWorkspaceError.unavailable }
        defer { close(descriptor) }
        var opened = stat(); guard fstat(descriptor, &opened) == 0, Self.fingerprint(opened) == fingerprint else { throw PDFWorkspaceError.staleSource }
        var hash = SHA256(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            try control.check(); let count = read(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw PDFWorkspaceError.unavailable }; if count == 0 { break }
            hash.update(data: Data(buffer.prefix(count)))
        }
        guard Self.fingerprint(try Self.stamp(source, regular: true, limit: Self.maximumPDFBytes)) == fingerprint else { throw PDFWorkspaceError.staleSource }
        let value = hash.finalize().map { String(format: "%02x", $0) }.joined()
        cachedFingerprint = fingerprint; cachedSHA256 = value; return value
    }
    private static func requireDirectory(_ url: URL) throws { _ = try stamp(url, regular: false, limit: Int.max) }
    private static func stamp(_ url: URL, regular: Bool, limit: Int) throws -> stat {
        var value = stat()
        guard lstat(url.path, &value) == 0 else { throw PDFWorkspaceError.unavailable }
        guard (value.st_mode & S_IFMT) == (regular ? S_IFREG : S_IFDIR), !regular || value.st_nlink == 1 else { throw PDFWorkspaceError.unsafePath }
        if regular { guard value.st_size >= 0, value.st_size <= limit else { throw PDFWorkspaceError.tooLarge } }
        return value
    }
    private static func fingerprint(_ value: stat) -> String { "\(value.st_dev):\(value.st_ino):\(value.st_size):\(value.st_nlink):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec):\(value.st_ctimespec.tv_sec):\(value.st_ctimespec.tv_nsec)" }
    private static func readRegular(_ url: URL, limit: Int, control: PDFWorkspaceIOControl) throws -> Data {
        _ = try stamp(url, regular: true, limit: limit)
        try PDFCloudFilePreparation.waitUntilReadable(url, checkCancellation: control.check)
        let before = try stamp(url, regular: true, limit: limit), descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw PDFWorkspaceError.unavailable }; defer { close(descriptor) }
        var opened = stat(); guard fstat(descriptor, &opened) == 0, fingerprint(before) == fingerprint(opened) else { throw PDFWorkspaceError.unavailable }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            try control.check(); let count = read(descriptor, &buffer, buffer.count)
            guard count >= 0 else { throw PDFWorkspaceError.unavailable }; if count == 0 { break }
            guard data.count + count <= limit else { throw PDFWorkspaceError.tooLarge }; data.append(contentsOf: buffer.prefix(count))
        }
        guard fingerprint(try stamp(url, regular: true, limit: limit)) == fingerprint(before), data.count == before.st_size else { throw PDFWorkspaceError.unavailable }
        return data
    }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x",$0) }.joined() }
    private static func writeNew(_ data: Data, to target: URL) throws {
        let temporary = target.deletingLastPathComponent().appendingPathComponent(".pending-" + UUID().uuidString.lowercased())
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        let file = open(temporary.path, O_RDONLY | O_NOFOLLOW)
        guard file >= 0 else { throw PDFWorkspaceError.unavailable }
        let synchronized = fsync(file); close(file)
        guard synchronized == 0 else { throw PDFWorkspaceError.unavailable }
        guard renamex_np(temporary.path, target.path, UInt32(RENAME_EXCL)) == 0 else { throw PDFWorkspaceError.unavailable }
        let directory = open(target.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directory >= 0 else { throw PDFWorkspaceError.unavailable }
        let durable = fsync(directory); close(directory)
        guard durable == 0 else { throw PDFWorkspaceError.unavailable }
    }
}
