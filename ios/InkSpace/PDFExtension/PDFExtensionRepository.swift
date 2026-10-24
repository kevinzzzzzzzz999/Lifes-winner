import Foundation
import CryptoKit
import Darwin
import ImageIO

struct PDFExtensionSnapshot: Sendable {
    var sourceURL: URL
    var sourceSHA256: String
    var records: [PDFExtensionEvent]
    var projection: PDFExtensionProjection
}
private final class PDFExtensionIOControl: @unchecked Sendable {
    let lock = NSLock()
    var cancelled = false
    var coordinator: NSFileCoordinator?
    private var cancellationHandler: (() -> Void)?
    func onCancellation(_ action: @escaping () -> Void) { lock.lock(); cancellationHandler = action; let stop = cancelled; lock.unlock(); if stop { action() } }
    func check() throws { lock.lock(); let value = cancelled; lock.unlock(); if value { throw CancellationError() } }
    func use(_ value: NSFileCoordinator) throws { lock.lock(); coordinator = value; let stop = cancelled; lock.unlock(); if stop { value.cancel(); throw CancellationError() } }
    func cancel() { lock.lock(); cancelled = true; let current = coordinator, handler = cancellationHandler; lock.unlock(); handler?(); current?.cancel() }
}
private final class PDFExtensionScope {
    let url: URL
    let acquired: Bool
    init(_ url: URL) { self.url = url; acquired = url.startAccessingSecurityScopedResource() }
    deinit { if acquired { url.stopAccessingSecurityScopedResource() } }
}

/// All filesystem work, hashing and coordination are on a private worker. Only
/// immutable event JSON is published; source PDF and board files stay read-only.
final class PDFExtensionRepository: @unchecked Sendable {
    static let maximumEntries = 20000
    static let maximumBytes = 64 * 1024 * 1024
    static let maximumPDFBytes = 256 * 1024 * 1024
    private let queue = DispatchQueue(label: "InkSpace.pdf-extension", qos: .userInitiated)
    let rootURL: URL?
    let sourceURL: URL
    private let backupDirectory: URL
    private var cachedFingerprint: String?
    private var cachedSHA256: String?
    init(rootURL: URL?, sourceURL: URL, backupDirectory: URL? = nil) {
        self.rootURL = rootURL; self.sourceURL = sourceURL
        self.backupDirectory = backupDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("InkSpace/PDFExtensionRecovery", isDirectory: true)
    }
    static func sidecarURL(for source: URL) -> URL { source.deletingLastPathComponent().appendingPathComponent("." + source.lastPathComponent + ".inkspace-extend", isDirectory: true) }
    func load() async throws -> PDFExtensionSnapshot {
        try await perform { control in
            try self.coordinated(writing: false, control: control) { source in
                let hash = try self.sourceHash(source, control: control), scan = try self.scan(Self.sidecarURL(for: source).appendingPathComponent("events",isDirectory:true), control: control)
                return PDFExtensionSnapshot(sourceURL: source, sourceSHA256: hash, records: scan.events, projection: .project(scan.events, warnings: scan.warnings))
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
    /// Export uses a private, verified disk snapshot. A large PDF is copied in
    /// chunks instead of retaining another full Data alongside the live reader.
    /// The caller owns destination and removes it after export (also on failure).
    func copyPDFSnapshot(to destination: URL, expectedSHA256: String) async throws {
        try await perform { control in
            try self.coordinated(writing: false, control: control) { source in
                guard destination.isFileURL, destination.standardizedFileURL != source.standardizedFileURL,
                      PDFExtensionEvent.hashValid(expectedSHA256) else { throw PDFWorkspaceError.unsafePath }
                let before = try Self.stamp(source, regular: true, limit: Self.maximumPDFBytes)
                let input = open(source.path, O_RDONLY | O_NOFOLLOW)
                guard input >= 0 else { throw PDFWorkspaceError.unavailable }
                defer { close(input) }
                var opened = stat()
                guard fstat(input, &opened) == 0, Self.fingerprint(opened) == Self.fingerprint(before) else { throw PDFWorkspaceError.staleSource }
                let output = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
                guard output >= 0 else { throw PDFWorkspaceError.unavailable }
                var complete = false
                defer { close(output); if !complete { try? FileManager.default.removeItem(at: destination) } }
                var hash = SHA256(), buffer = [UInt8](repeating: 0, count: 64 * 1024), total = 0
                while true {
                    try control.check()
                    let count = read(input, &buffer, buffer.count)
                    guard count >= 0 else { throw PDFWorkspaceError.unavailable }
                    if count == 0 { break }
                    total += count
                    guard total <= Self.maximumPDFBytes else { throw PDFWorkspaceError.tooLarge }
                    hash.update(data: Data(buffer.prefix(count)))
                    try buffer.withUnsafeBytes { bytes in
                        var offset = 0
                        while offset < count {
                            try control.check()
                            let written = write(output, bytes.baseAddress!.advanced(by: offset), count - offset)
                            guard written > 0 else { throw PDFWorkspaceError.unavailable }
                            offset += written
                        }
                    }
                }
                guard total == before.st_size,
                      Self.fingerprint(try Self.stamp(source, regular: true, limit: Self.maximumPDFBytes)) == Self.fingerprint(before),
                      hash.finalize().map({ String(format: "%02x", $0) }).joined() == expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                try control.check()
                guard fsync(output) == 0 else { throw PDFWorkspaceError.unavailable }
                complete = true
            }
        }
    }
    /// Exact IDs make retries idempotent, including a partially published batch.
    /// Recovery copies are persisted before any new event becomes visible.
    func publish(_ events: [PDFExtensionEvent], expectedSHA256: String) async throws -> PDFExtensionSnapshot {
        guard rootURL != nil,!events.isEmpty,events.count<=32 else { throw PDFWorkspaceError.unsafePath }
        let validated=try events.map { try PDFExtensionEvent.decodeValidated($0.encoded()) }
        return try await perform(readOnly: false) { control in
            try self.coordinated(writing:true,control:control) { source in
                guard try self.sourceHash(source,control:control)==expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                let sidecar=Self.sidecarURL(for:source), directory=sidecar.appendingPathComponent("events",isDirectory:true)
                let scan=try self.scan(directory,control:control)
                var merged=scan.events, bytes=scan.bytes, additions:[(PDFExtensionEvent,Data)]=[]
                for event in validated {
                    guard event.sourceSHA256==expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                    let data=try event.encoded()
                    if let prior=merged.first(where:{$0.id==event.id}) { guard prior==event else { throw PDFWorkspaceError.invalidRecord };continue }
                    if let base=event.baseEventID,let prior=merged.first(where:{$0.id==base}) {
                        guard prior.targetID==event.targetID,prior.sourceSHA256==event.sourceSHA256 else { throw PDFWorkspaceError.invalidRecord }
                    }
                    bytes+=data.count;merged.append(event);additions.append((event,data))
                }
                guard scan.entries+additions.count<=Self.maximumEntries,bytes<=Self.maximumBytes else { throw PDFWorkspaceError.tooLarge }
                let recovery=self.backupDirectory.appendingPathComponent(Self.digest(Data(source.path.utf8)),isDirectory:true)
                try FileManager.default.createDirectory(at:recovery,withIntermediateDirectories:true)
                for (event,data) in additions {
                    let target=recovery.appendingPathComponent(event.id+".json")
                    if FileManager.default.fileExists(atPath:target.path) { guard try Self.readRegular(target,limit:PDFExtensionEvent.maximumBytes,control:control)==data else { throw PDFWorkspaceError.backupFailed } }
                    else { try Self.writeNew(data,to:target) }
                }
                if !FileManager.default.fileExists(atPath:sidecar.path) { try FileManager.default.createDirectory(at:sidecar,withIntermediateDirectories:false) }
                try Self.requireDirectory(sidecar)
                if !FileManager.default.fileExists(atPath:directory.path) { try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false) }
                try Self.requireDirectory(directory)
                for (event,data) in additions {
                    try control.check();let target=directory.appendingPathComponent(event.id+".json")
                    do { try Self.writeNew(data,to:target) }
                    catch { guard (try? Self.readRegular(target,limit:PDFExtensionEvent.maximumBytes,control:control))==data else { throw error } }
                }
                guard try self.sourceHash(source,control:control)==expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                return .init(sourceURL:source,sourceSHA256:expectedSHA256,records:merged,projection:.project(merged,warnings:scan.warnings))
            }
        }
    }
    func saveAsset(_ data:Data, fileExtension:String, expectedSHA256:String) async throws -> (String,String) {
        guard rootURL != nil,data.count<=10*1024*1024,["png","jpg"].contains(fileExtension) else { throw PDFWorkspaceError.tooLarge }
        guard let imageSource=CGImageSourceCreateWithData(data as CFData,nil),
              let type=CGImageSourceGetType(imageSource) as String?,
              type == (fileExtension == "png" ? "public.png" : "public.jpeg"),
              let props=CGImageSourceCopyPropertiesAtIndex(imageSource,0,nil) as? [CFString:Any],
              let width=props[kCGImagePropertyPixelWidth] as? Int,let height=props[kCGImagePropertyPixelHeight] as? Int,
              width>0,height>0,width<=16000000/height else { throw PDFWorkspaceError.invalidRecord }
        let hash=Self.digest(data),relative="assets/"+Self.digest(data)+"."+fileExtension
        return try await perform(readOnly: false) { control in
            try self.coordinated(writing:true,control:control) { source in
                guard try self.sourceHash(source,control:control)==expectedSHA256 else { throw PDFWorkspaceError.staleSource }
                let sidecar=Self.sidecarURL(for:source),assets=sidecar.appendingPathComponent("assets",isDirectory:true)
                if !FileManager.default.fileExists(atPath:sidecar.path) { try FileManager.default.createDirectory(at:sidecar,withIntermediateDirectories:false) };try Self.requireDirectory(sidecar)
                if !FileManager.default.fileExists(atPath:assets.path) { try FileManager.default.createDirectory(at:assets,withIntermediateDirectories:false) };try Self.requireDirectory(assets)
                let target=sidecar.appendingPathComponent(relative)
                if FileManager.default.fileExists(atPath:target.path) { guard try Self.readRegular(target,limit:10*1024*1024,control:control)==data else { throw PDFWorkspaceError.invalidRecord } }
                else { try Self.writeNew(data,to:target) }
                return (relative,hash)
            }
        }
    }
    func readAsset(_ image:PDFExtensionImage) async throws -> Data {
        guard PDFExtensionEvent.hashValid(image.sha256),image.resource=="assets/"+image.sha256+".png" || image.resource=="assets/"+image.sha256+".jpg" else { throw PDFWorkspaceError.unsafePath }
        return try await perform { control in
            try self.coordinated(writing:false,control:control) { source in
                let sidecar=Self.sidecarURL(for:source);try Self.requireDirectory(sidecar);try Self.requireDirectory(sidecar.appendingPathComponent("assets"))
                let data=try Self.readRegular(sidecar.appendingPathComponent(image.resource),limit:10*1024*1024,control:control)
                guard Self.digest(data)==image.sha256 else { throw PDFWorkspaceError.invalidRecord };return data
            }
        }
    }
    private func perform<T>(readOnly: Bool = true, _ body: @escaping (PDFExtensionIOControl) throws -> T) async throws -> T {
        let control = PDFExtensionIOControl()
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
    private func coordinated<T>(writing: Bool, control: PDFExtensionIOControl, body: (URL) throws -> T) throws -> T {
        let scope = PDFExtensionScope(rootURL ?? sourceURL); defer { withExtendedLifetime(scope) {} }
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
    private struct Scan { var events: [PDFExtensionEvent] = []; var warnings: [String] = []; var entries = 0; var bytes = 0 }
    private func scan(_ directory: URL, control: PDFExtensionIOControl) throws -> Scan {
        var result = Scan(), invalid = 0
        let sidecar=directory.deletingLastPathComponent()
        var parentInfo=stat()
        if lstat(sidecar.path,&parentInfo)==0 {try Self.requireDirectory(sidecar)} else if errno != ENOENT {throw PDFWorkspaceError.unavailable}
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
                guard stamp.st_size <= PDFExtensionEvent.maximumBytes else { invalid += 1; continue }
                let data = try Self.readRegular(url, limit: PDFExtensionEvent.maximumBytes, control: control)
                let event = try PDFExtensionEvent.decodeValidated(data)
                guard url.lastPathComponent == event.id + ".json" else { throw PDFWorkspaceError.invalidRecord }
                result.events.append(event)
            } catch PDFWorkspaceError.tooLarge { throw PDFWorkspaceError.tooLarge }
            catch is CancellationError { throw CancellationError() }
            catch let error as PDFCloudFilePreparation.Failure { throw error }
            catch { invalid += 1 }
        }
        if invalid > 0 { result.warnings = [String(localized: "有 \(invalid) 条留白记录暂无法读取；原记录保持不变。")] }
        return result
    }
    private func sourceHash(_ source: URL, control: PDFExtensionIOControl) throws -> String {
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
    private static func readRegular(_ url: URL, limit: Int, control: PDFExtensionIOControl) throws -> Data {
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
