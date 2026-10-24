import Foundation
import Darwin
import Synchronization
#if os(iOS)
import os
#endif

/// Measurement only: no canvas reads, product objects, user content or throwing
/// caller API. A missing record is an incomplete measurement, never a save result.
enum BoardLassoMemoryProbe {
    struct Scope: Equatable, Sendable {
        let session: UUID
        let boardID: UUID
    }
    struct Context: Sendable {
        fileprivate let scope: Scope
        fileprivate let operation: UInt64
        fileprivate let generation: UInt64
    }
    enum Phase: UInt16 {
        case window = 1, saveAlreadyActive, memory, dropped
        case lasso = 20, transformQueued, transformLease, transformWorker, transformAwait, undoRegistration, canvasCommit
        case saveRequest = 40, saveWait, save, saveSnapshot, archiveCacheHit, archivePending, archiveTask, archiveAwait
        case checkpointLease, checkpoint, exportLease, export, encodeAwait, nativeWrite, nativeCommit, companion
        case pdfLease, pdf, conflictEncode, conflictWrite, pdfEncode, pdfWrite, backupLease, backup, saveCatch
        case archiveLease = 80, archiveWorkerQueued, archiveWorker, archiveMemoryCheck, nativeArchive, archiveReturn
        case encodeLease = 90, encodeWorkerQueued, encodeWorker, encodeMemoryCheck, jsonEncode, encodedSizeCheck, encodeReturn
    }
    enum Event: UInt8 { case begin = 1, end, point, cancelled, failed, sample }
    struct MemorySample: Sendable {
        let result: Int32
        let footprint: UInt64
        let available: UInt64
    }
    protocol Sink: AnyObject {
        func append(_ bytes: Data) throws
        func close()
    }

    static let shared = Recorder()
    static func begin(scope: Scope, selectedStrokes: Int, saveAlreadyActive: Bool) -> Context? {
        shared.begin(scope: scope, selectedStrokes: selectedStrokes, saveAlreadyActive: saveAlreadyActive)
    }
    static func context(session: UUID, boardID: UUID) -> Context? {
        shared.context(scope: Scope(session: session, boardID: boardID))
    }
    static func mark(_ context: Context?, _ phase: Phase, _ event: Event, value: UInt64 = 0) {
        shared.mark(context, phase, event, value: value)
    }
    static func retire(session: UUID) { shared.retire(session: session) }

    /// Fixed little-endian record: event ns, collector ns, sequence, operation,
    /// phase u16, event u8, reserved u8, task_info result i32, footprint,
    /// available and numeric value. Exactly 64 bytes, including the header.
    struct Record {
        var time: UInt64
        var sequence: UInt64 = 0
        var operation: UInt64 = 0
        var phase: Phase
        var event: Event
        var result: Int32 = 0
        var footprint: UInt64 = 0
        var available: UInt64 = 0
        var value: UInt64 = 0
        func bytes(collectedAt: UInt64) -> Data {
            var bytes = Data(capacity: 64)
            func add<T: FixedWidthInteger>(_ value: T) {
                var little = value.littleEndian
                withUnsafeBytes(of: &little) { bytes.append(contentsOf: $0) }
            }
            add(time); add(collectedAt); add(sequence); add(operation)
            add(phase.rawValue); add(event.rawValue); add(UInt8(0)); add(result)
            add(footprint); add(available); add(value)
            return bytes
        }
    }

    /// All file/timer/sampler work belongs to queue. Producer admission uses
    /// try(), so contention can drop diagnostics but never stall Pencil/main.
    final class Recorder: @unchecked Sendable {
        static let duration: UInt64 = 60_000_000_000
        static let recordLimit = 2_048
        static let ringLimit = 256
        static let byteLimit = 256 * 1_024
        private let lock = NSLock()
        private let lockDrops = Atomic<UInt64>(0)
        private let queue: DispatchQueue
        private let clock: @Sendable () -> UInt64
        private let sampler: @Sendable () -> MemorySample
        private let sinkFactory: @Sendable (UInt64) throws -> Sink
        private let automaticTimer: Bool
        private var ring = [Record?](repeating: nil, count: ringLimit)
        private var head = 0, count = 0
        private var scope: Scope?
        private var start: UInt64 = 0, deadline: UInt64 = 0, nextWindowNotBefore: UInt64 = 0, generation: UInt64 = 0
        private var nextOperation: UInt64 = 0, admitted = 0, dropped: UInt64 = 0
        private var startLockDrops: UInt64 = 0, reportedDrops: UInt64 = 0
        private var closeReason: UInt64 = 0
        private var accepting = false
        // Queue-owned state below: never accessed by a producer.
        private var outputGeneration: UInt64 = 0
        private var sink: Sink?
        private var timer: DispatchSourceTimer?
        private var written = 0

        init(queue: DispatchQueue = DispatchQueue(label: "InkSpace.lasso-memory-probe", qos: .utility),
             clock: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
             sampler: @escaping @Sendable () -> MemorySample = { readMemory() },
             sinkFactory: @escaping @Sendable (UInt64) throws -> Sink = { try FileSink(sequence: $0) },
             automaticTimer: Bool = true) {
            self.queue = queue; self.clock = clock; self.sampler = sampler
            self.sinkFactory = sinkFactory; self.automaticTimer = automaticTimer
        }

        func begin(scope incoming: Scope, selectedStrokes: Int, saveAlreadyActive: Bool) -> Context? {
            guard selectedStrokes >= 10_000, tryAdmissionLock() else { return nil }
            let now = clock()
            if scope != nil {
                guard accepting, scope == incoming, now < deadline else { lock.unlock(); return nil }
                nextOperation &+= 1
                let context = Context(scope: incoming, operation: nextOperation, generation: generation)
                enqueue(Record(time: now, operation: context.operation, phase: .lasso, event: .begin, value: UInt64(selectedStrokes)))
                lock.unlock(); return context
            }
            guard now >= nextWindowNotBefore else { lock.unlock(); return nil }
            generation &+= 1; nextOperation = 1; admitted = 0; dropped = 0
            startLockDrops = lockDrops.load(ordering: .relaxed); reportedDrops = 0; closeReason = 0
            start = now; deadline = now.addingReportingOverflow(Self.duration).overflow ? UInt64.max : now + Self.duration
            nextWindowNotBefore = deadline
            scope = incoming; accepting = true
            let token = generation
            let context = Context(scope: incoming, operation: nextOperation, generation: generation)
            enqueue(Record(time: now, phase: .window, event: .begin, value: 1))
            enqueue(Record(time: now, phase: .saveAlreadyActive, event: .point, value: saveAlreadyActive ? 1 : 0))
            enqueue(Record(time: now, operation: context.operation, phase: .lasso, event: .begin, value: UInt64(selectedStrokes)))
            lock.unlock()
            queue.async { [weak self] in self?.open(generation: token) }
            return context
        }

        func context(scope incoming: Scope) -> Context? {
            guard tryAdmissionLock() else { return nil }
            defer { lock.unlock() }
            guard accepting, scope == incoming, clock() < deadline else { return nil }
            nextOperation &+= 1
            return Context(scope: incoming, operation: nextOperation, generation: generation)
        }

        func mark(_ context: Context?, _ phase: Phase, _ event: Event, value: UInt64 = 0) {
            guard let context, tryAdmissionLock() else { return }
            defer { lock.unlock() }
            let now = clock()
            guard accepting, scope == context.scope, context.generation == generation, now < deadline else { return }
            enqueue(Record(time: now, operation: context.operation, phase: phase, event: event, value: value))
        }

        func retire(session: UUID) {
            guard tryAdmissionLock() else { return }
            defer { lock.unlock() }
            guard let current = scope, current.session == session, accepting else { return }
            closeReason = clock() < deadline ? 1 : 0
            accepting = false
        }

        private func tryAdmissionLock() -> Bool {
            if lock.try() { return true }
            lockDrops.wrappingAdd(1, ordering: .relaxed)
            return false
        }

        private func enqueue(_ incoming: Record, terminal: Bool = false) {
            // Reserve two records for loss coverage and terminal reason.
            guard admitted < Self.recordLimit - (terminal ? 0 : 2) else {
                closeReason = 2; accepting = false; return
            }
            guard count < Self.ringLimit else { dropped &+= 1; return }
            var record = incoming
            admitted += 1; record.sequence = UInt64(admitted)
            ring[(head + count) % Self.ringLimit] = record; count += 1
        }

        private func open(generation token: UInt64) {
            dispatchPrecondition(condition: .onQueue(queue))
            outputGeneration = token; written = 0
            do { sink = try sinkFactory(token) }
            catch { disable(generation: token); return }
            if automaticTimer {
                let timer = DispatchSource.makeTimerSource(queue: queue)
                timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250), leeway: .milliseconds(20))
                timer.setEventHandler { [weak self] in self?.collect() }
                self.timer = timer; timer.resume()
            }
            collect()
        }

        /// Queue-only; injectable clock/sampler/sink also exercise this exact
        /// collector on the host, without a product setting or device flag.
        func collect() {
            dispatchPrecondition(condition: .onQueue(queue))
            guard sink != nil else { return }
            lock.lock()
            let now = clock()
            guard scope != nil, generation == outputGeneration else { lock.unlock(); close(); return }
            var batch = [Record](); batch.reserveCapacity(count + 2)
            func drain() {
                while count > 0 {
                    if let record = ring[head] { batch.append(record) }
                    ring[head] = nil; head = (head + 1) % Self.ringLimit; count -= 1
                }
            }
            // Drain first: a full ring must not itself suppress the drop report.
            drain()
            if now >= deadline { accepting = false }
            let knownDrops = dropped &+ (lockDrops.load(ordering: .relaxed) &- startLockDrops)
            if accepting {
                if knownDrops > reportedDrops {
                    enqueue(Record(time: now, phase: .dropped, event: .point, result: 1, value: knownDrops))
                    reportedDrops = knownDrops
                }
                if accepting {
                    let memory = sampler()
                    enqueue(Record(time: now, phase: .memory, event: .sample,
                        result: memory.result, footprint: memory.footprint, available: memory.available))
                }
            }
            if !accepting {
                // Counts are a lower bound: a preempted producer can report a
                // failed try-lock after this snapshot. Result=1 explicitly marks
                // best-effort coverage, even when knownDrops is zero.
                enqueue(Record(time: min(now, deadline), phase: .dropped, event: .point,
                    result: 1, value: knownDrops), terminal: true)
                let event: Event = closeReason == 1 ? .cancelled : closeReason == 2 ? .failed : .end
                enqueue(Record(time: min(now, deadline), phase: .window, event: event,
                    value: closeReason == 0 ? 60 : closeReason), terminal: true)
            }
            drain()
            let finished = !accepting
            let token = generation
            if finished { scope = nil }
            lock.unlock()
            do {
                for record in batch {
                    let bytes = record.bytes(collectedAt: now)
                    guard bytes.count == 64, written <= Self.byteLimit - bytes.count else { disable(generation: token); return }
                    try sink?.append(bytes); written += bytes.count
                }
            } catch { disable(generation: token); return }
            if finished { close() }
        }

        private func disable(generation token: UInt64) {
            lock.lock()
            if generation == token {
                accepting = false; scope = nil
                while count > 0 { ring[head] = nil; head = (head + 1) % Self.ringLimit; count -= 1 }
            }
            lock.unlock(); close()
        }
        private func close() {
            timer?.cancel(); timer = nil
            sink?.close(); sink = nil
        }
    }

    private static func readMemory() -> MemorySample {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
#if os(iOS)
        let available = UInt64(os_proc_available_memory())
#else
        let available = UInt64.max // Host tests inject a sampler; never report zero as success.
#endif
        return MemorySample(result: result, footprint: result == KERN_SUCCESS ? info.phys_footprint : UInt64.max, available: available)
    }

    private final class FileSink: Sink {
        private let file: FileHandle
        init(sequence: UInt64) throws {
            let manager = FileManager.default
            let directory = manager.temporaryDirectory.appendingPathComponent("InkSpace-LassoMemory", isDirectory: true)
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
            let prefix = "lasso-memory-"
            let existing = try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                .filter { url in
                    let name = url.lastPathComponent
                    guard name.hasPrefix(prefix), name.hasSuffix(".bin"),
                          UInt64(name.dropFirst(prefix.count).dropLast(4)) != nil,
                          let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]) else { return false }
                    return values.isRegularFile == true && values.isSymbolicLink != true
                }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            for old in existing.prefix(max(0, existing.count - 2)) { try manager.removeItem(at: old) }
            // Uptime plus a process-local sequence is numeric, not a note identifier.
            let filename = "\(prefix)\(DispatchTime.now().uptimeNanoseconds &+ sequence).bin"
            let url = directory.appendingPathComponent(filename)
            let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
            file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        }
        func append(_ bytes: Data) throws { try file.write(contentsOf: bytes) }
        func close() { try? file.close() }
    }
}
