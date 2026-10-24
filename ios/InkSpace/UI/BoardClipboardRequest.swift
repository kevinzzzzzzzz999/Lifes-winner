import Foundation

enum BoardClipboardRequestError: Error, LocalizedError {
    case timedOut, invalidFilename, invalidSource
    var errorDescription: String? {
        message(zh: Locale.preferredLanguages.first?.hasPrefix("zh") == true)
    }
    func message(zh: Bool) -> String {
        switch self {
        case .timedOut: return zh ? "剪贴板资料读取超时，请重新粘贴。" : "The clipboard provider took too long. Try pasting again."
        case .invalidFilename: return zh ? "剪贴板附件的文件名无效。" : "The clipboard attachment name is invalid."
        case .invalidSource: return zh ? "剪贴板没有提供可读取的文件。" : "The clipboard provider did not supply a readable file."
        }
    }
}

/// Owns only its newly created temporary directory. A cancelled UI must call
/// close(), never remove directory itself: a coordinator may still be unwinding.
final class BoardPasteStaging: @unchecked Sendable {
    let directory: URL
    private let lock = NSLock()
    private var closed = false
    private var leases = 0
    private var cleaned = false

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("BoardPaste-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                              attributes: [.posixPermissions: 0o700])
    }
    func close() {
        lock.lock(); closed = true
        let clean = leases == 0 && !cleaned
        if clean { cleaned = true }
        lock.unlock()
        if clean { try? FileManager.default.removeItem(at: directory) }
    }
    deinit { close() }

    fileprivate func lease() throws -> Lease {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { throw CancellationError() }
        leases += 1
        return Lease(self)
    }
    fileprivate func destination(_ filename: String) throws -> URL {
        guard !filename.isEmpty, filename != ".", filename != "..", filename.utf8.count <= 255,
              !filename.contains("/"), !filename.contains("\\"), !filename.contains("\0") else {
            throw BoardClipboardRequestError.invalidFilename
        }
        return directory.appendingPathComponent(filename, isDirectory: false)
    }
    private func release() {
        lock.lock(); leases -= 1
        let clean = closed && leases == 0 && !cleaned
        if clean { cleaned = true }
        lock.unlock()
        if clean { try? FileManager.default.removeItem(at: directory) }
    }
    fileprivate final class Lease {
        private let staging: BoardPasteStaging
        init(_ staging: BoardPasteStaging) { self.staging = staging }
        deinit { staging.release() }
    }
}

/// Bridges provider callbacks without a task group: a hung provider/coordinate
/// cannot hold the caller's cancellation or deadline hostage.
enum BoardClipboardRequest {
    static func awaitResult<Value>(
        timeout: TimeInterval = 30,
        start: @escaping (@escaping (Result<Value, Error>) -> Void) -> Progress?
    ) async throws -> Value {
        let box = RequestBox<Value>()
        return try await run(box, timeout: timeout) {
            let progress = start { box.finish($0) }
            box.installProgress(progress)
        }
    }

    /// NSItemProvider.loadFileRepresentation URLs expire when its callback
    /// returns. Copy in that callback, on the provider-start utility worker.
    static func copyTemporaryFile(
        timeout: TimeInterval = 30, staging: BoardPasteStaging, filename: String,
        start: @escaping (@escaping (URL?, Error?) -> Void) -> Progress?
    ) async throws -> URL {
        let target = try staging.destination(filename)
        let box = RequestBox<URL>()
        return try await run(box, timeout: timeout) {
            let progress = start { source, error in
                guard box.claim() else { return }
                do {
                    guard let source else { throw error ?? BoardClipboardRequestError.invalidSource }
                    let lease = try staging.lease()
                    // The lease outlives all blocking reads and protected writes.
                    defer { withExtendedLifetime(lease) {} }
                    try copy(source, to: target, box: box)
                    box.finish(.success(target))
                } catch { box.finish(.failure(error)) }
            }
            box.installProgress(progress)
        }
    }

    /// For a fileURL supplied as clipboard data. Coordination and security scope
    /// remain on a worker until coordinate() really returns, even if UI times out.
    static func copyCoordinatedFile(
        source: URL, staging: BoardPasteStaging, filename: String,
        timeout: TimeInterval = 30
    ) async throws -> URL {
        let target = try staging.destination(filename)
        let box = RequestBox<URL>()
        return try await run(box, timeout: timeout) {
            guard box.claim() else { return }
            do {
                let lease = try staging.lease()
                defer { withExtendedLifetime(lease) {} }
                try box.check()
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                let coordinator = NSFileCoordinator()
                box.installCancellation { coordinator.cancel() }
                try box.check()
                var coordination: NSError?
                var result: Result<URL, Error>?
                coordinator.coordinate(readingItemAt: source, options: [], error: &coordination) { readable in
                    result = Result { try copy(readable, to: target, box: box); return target }
                }
                if let coordination { throw coordination }
                guard let result else { try box.check(); throw BoardClipboardRequestError.invalidSource }
                box.finish(result)
            } catch { box.finish(.failure(error)) }
        }
    }

    static func writeData(
        _ bytes: Data, staging: BoardPasteStaging, filename: String,
        timeout: TimeInterval = 30
    ) async throws -> URL {
        let target = try staging.destination(filename)
        let box = RequestBox<URL>()
        return try await run(box, timeout: timeout) {
            guard box.claim() else { return }
            do {
                let lease = try staging.lease()
                defer { withExtendedLifetime(lease) {} }
                let output = try makeOutput(target, box: box)
                defer { try? output.close() }
                var offset = 0
                while offset < bytes.count {
                    try box.check()
                    let end = min(bytes.count, offset + 256 * 1024)
                    let chunk = bytes.subdata(in: offset..<end)
                    try box.protectedCopy { try output.write(contentsOf: chunk) }
                    offset = end
                }
                try box.check()
                box.finish(.success(target))
            } catch { box.finish(.failure(error)) }
        }
    }

    private static func run<Value>(
        _ box: RequestBox<Value>, timeout: TimeInterval, start: @escaping () -> Void
    ) async throws -> Value {
        try await withTaskCancellationHandler {
            if Task.isCancelled { box.finish(.failure(CancellationError())) }
            return try await withCheckedThrowingContinuation { continuation in
                guard box.install(continuation) else { return }
                box.deadline(timeout)
                DispatchQueue.global(qos: .utility).async {
                    guard box.isPending else { return }
                    start()
                }
            }
        } onCancel: { box.finish(.failure(CancellationError())) }
    }

    private static func copy(_ source: URL, to target: URL, box: RequestBox<URL>) throws {
        try box.check()
        guard source.isFileURL,
              try source.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
            throw BoardClipboardRequestError.invalidSource
        }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        // Each operation is authorized before I/O; I/O never holds the outcome
        // lock. An already authorized operation may unwind after cancellation
        // inside this leased private stage, but cannot publish a usable result.
        let output = try makeOutput(target, box: box)
        defer { try? output.close() }
        while true {
            try box.check()
            guard let chunk = try input.read(upToCount: 256 * 1024), !chunk.isEmpty else { break }
            try box.protectedCopy { try output.write(contentsOf: chunk) }
        }
        try box.check()
    }

    private static func makeOutput(_ target: URL, box: RequestBox<URL>) throws -> FileHandle {
        try box.protectedCopy(step: "create") {
            guard !FileManager.default.fileExists(atPath: target.path),
                  FileManager.default.createFile(atPath: target.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else {
                throw BoardClipboardRequestError.invalidSource
            }
            return try FileHandle(forWritingTo: target)
        }
    }
}

private final class RequestBox<Value>: @unchecked Sendable {
    private static var timerQueue: DispatchQueue { BoardClipboardDeadline.queue }
    private let lock = NSLock()
    private var result: Result<Value, Error>?
    private var continuation: CheckedContinuation<Value, Error>?
    private var progress: Progress?
    private var cancelActions: [() -> Void] = []
    private var timer: DispatchSourceTimer?
    private var claimed = false

    var isPending: Bool { lock.lock(); defer { lock.unlock() }; return result == nil }
    func install(_ continuation: CheckedContinuation<Value, Error>) -> Bool {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result); return false }
        self.continuation = continuation
        lock.unlock(); return true
    }
    func deadline(_ seconds: TimeInterval) {
        guard seconds.isFinite, seconds > 0 else { finish(.failure(BoardClipboardRequestError.timedOut)); return }
        let timer = DispatchSource.makeTimerSource(queue: Self.timerQueue)
        timer.schedule(deadline: .now() + min(seconds, 3600))
        timer.setEventHandler { [weak self] in self?.finish(.failure(BoardClipboardRequestError.timedOut)) }
        lock.lock(); let retain = result == nil
        if retain { self.timer = timer }
        lock.unlock()
        timer.resume()
        if !retain { timer.cancel() }
    }
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard result == nil, !claimed else { return false }
        claimed = true; return true
    }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if case .failure(let error)? = result { throw error }
        if result != nil { throw CancellationError() }
    }
    func protectedCopy<T>(step: String = "write", _ operation: () throws -> T) throws -> T {
        lock.lock()
        guard result == nil, claimed else {
            let error: Error
            if case .failure(let failure)? = result { error = failure }
            else { error = CancellationError() }
            lock.unlock()
            throw error
        }
        lock.unlock()
        #if BOARD_CLIPBOARD_TESTS
        BoardClipboardTestHooks.beforeIO(step)
        #endif
        return try operation()
    }
    func installProgress(_ progress: Progress?) {
        guard let progress else { return }
        lock.lock()
        let cancel: Bool
        if case .failure? = result { cancel = true }
        else { cancel = false; if result == nil { self.progress = progress } }
        lock.unlock()
        if cancel { Self.cancel { progress.cancel() } }
    }
    func installCancellation(_ action: @escaping () -> Void) {
        lock.lock()
        let cancel: Bool
        if case .failure? = result { cancel = true }
        else { cancel = false; if result == nil { cancelActions.append(action) } }
        lock.unlock()
        if cancel { Self.cancel(action) }
    }
    func finish(_ outcome: Result<Value, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = outcome
        let continuation = continuation, timer = timer, progress = progress, actions = cancelActions
        self.continuation = nil; self.timer = nil; self.progress = nil; cancelActions = []
        lock.unlock()
        timer?.cancel()
        continuation?.resume(with: outcome)
        if case .failure = outcome {
            if let progress { Self.cancel { progress.cancel() } }
            for action in actions { Self.cancel(action) }
        }
    }
    private static func cancel(_ action: @escaping () -> Void) {
        // Provider cancellation handlers are outside the continuation's lock
        // and outside the caller/main actor; even a bad handler cannot block UI.
        DispatchQueue.global(qos: .utility).async(execute: action)
    }
}
private enum BoardClipboardDeadline {
    static let queue = DispatchQueue(label: "inkspace.clipboard.deadline", qos: .userInitiated)
}

#if BOARD_CLIPBOARD_TESTS
/// Controlled I/O barrier for regression tests compiled with the real helper.
/// It is absent from the production module and never executes under its locks.
enum BoardClipboardTestHooks {
    private static let lock = NSLock()
    private static var hook: ((String) -> Void)?
    static func install(_ value: ((String) -> Void)?) {
        lock.lock(); hook = value; lock.unlock()
    }
    static func beforeIO(_ step: String) {
        lock.lock(); let value = hook; lock.unlock(); value?(step)
    }
}
#endif
