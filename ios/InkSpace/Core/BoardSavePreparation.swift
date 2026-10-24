import Foundation
import PencilKit
#if os(iOS)
import os
#endif

/// Inputs are value snapshots captured by the store before suspension. The
/// worker never reads a live canvas or BoardStore, and large serialization work
/// cannot occupy the main actor while PencilKit is processing new input.
enum BoardSavePreparation {
    enum EncodingFailure: LocalizedError {
        case memoryPressure, tooLarge
        var errorDescription: String? {
            switch self {
            case .memoryPressure:
                return String(localized: "当前可用内存不足，本次操作已安全暂缓；白板内容与未保存修改仍保留。请保持此白板并暂时关闭其他大型文档后重试。")
            case .tooLarge:
                return String(localized: "白板超过可重新打开的大小上限，未覆盖原文件；内容仍在内存中，可撤销修改或拆分白板后再保存。请保留当前白板。")
            }
        }
    }

    /// A successful save must remain readable by the very same application.
    /// Check before returning bytes to any caller that can replace a board file.
    static func validateEncodedSize(_ byteCount: Int) throws {
        guard byteCount >= 0, byteCount <= BoardReadLoader.maximumBytes else {
            throw EncodingFailure.tooLarge
        }
    }

    /// Reserve room before Foundation starts a non-recoverable allocation.
    /// The same conservative estimate protects optional recovery checkpoints.
    static func requiredEncodingHeadroom(_ document: BoardDocument) -> UInt64 {
        LocalBoardBackupStore.requiredEncodingHeadroom(
            estimatedBytes: LocalBoardBackupStore.estimatedEncodingBytes(document))
    }

    static func checkEncodingMemory(_ document: BoardDocument, availableBytes: UInt64) throws {
        guard availableBytes >= requiredEncodingHeadroom(document) else {
            throw EncodingFailure.memoryPressure
        }
    }

    /// One process-wide lease for the native archive/JSON/export/large-transform
    /// phases. It never locks ordinary Pencil input or lightweight previews.
    /// Every caller releases exactly once, including cancellation while queued.
    private actor InkMemoryLease {
        private var held = false
        private var waiting: [(UUID, CheckedContinuation<Void, Error>)] = []
        func acquire(_ id: UUID) async throws {
            try Task.checkCancellation()
            if !held { held = true; return }
            try await withCheckedThrowingContinuation { continuation in
                waiting.append((id, continuation))
            }
        }
        func cancel(_ id: UUID) {
            guard let index = waiting.firstIndex(where: { $0.0 == id }) else { return }
            let continuation = waiting.remove(at: index).1
            continuation.resume(throwing: CancellationError())
        }
        func release() {
            if waiting.isEmpty { held = false }
            else { waiting.removeFirst().1.resume(returning: ()) }
        }
    }
    private static let memoryLease = InkMemoryLease()

    static func withInkMemoryLease<Value>(_ operation: () async throws -> Value) async throws -> Value {
        let id = UUID()
        try await withTaskCancellationHandler(operation: {
            try await memoryLease.acquire(id)
        }, onCancel: {
            Task { await memoryLease.cancel(id) }
        })
        do {
            try Task.checkCancellation()
            let value = try await operation()
            await memoryLease.release()
            return value
        } catch {
            await memoryLease.release()
            throw error
        }
    }

    /// Inspect only cheap native counts, never interpolate points or serialize to
    /// find out if serialization is safe. Saturation rejects impossible estimates.
    static func estimatedDrawingBytes(strokeCount: Int, controlPointCount: Int) -> UInt64 {
        guard strokeCount >= 0, controlPointCount >= 0 else { return UInt64.max }
        let points = UInt64(controlPointCount).multipliedReportingOverflow(by: 64)
        let strokes = UInt64(strokeCount).multipliedReportingOverflow(by: 1024)
        guard !points.overflow, !strokes.overflow else { return UInt64.max }
        let combined = points.partialValue.addingReportingOverflow(strokes.partialValue)
        let reserved = combined.partialValue.addingReportingOverflow(64 * 1024)
        return combined.overflow || reserved.overflow ? UInt64.max : reserved.partialValue
    }
    static func requiredDrawingHeadroom(strokeCount: Int, controlPointCount: Int) -> UInt64 {
        let estimate = estimatedDrawingBytes(strokeCount: strokeCount, controlPointCount: controlPointCount)
        let reserve: UInt64 = 128 * 1024 * 1024
        guard estimate <= (UInt64.max - reserve) / 3 else { return UInt64.max }
        return reserve + estimate * 3
    }
    static func checkDrawingMemory(strokeCount: Int, controlPointCount: Int, availableBytes: UInt64) throws {
        let required = requiredDrawingHeadroom(strokeCount: strokeCount, controlPointCount: controlPointCount)
        guard required < UInt64.max, availableBytes >= required else {
            throw EncodingFailure.memoryPressure
        }
    }

    /// Also available to a large native transform/copy *inside* its lease.
    /// No source drawing is serialized or changed by this preflight.
    static func checkDrawingMemory(_ drawing: PKDrawing, availableBytes: UInt64? = nil) throws {
        let strokes = drawing.strokes
        var points = 0
        for stroke in strokes {
            let added = points.addingReportingOverflow(stroke.path.count)
            guard !added.overflow else { throw EncodingFailure.memoryPressure }
            points = added.partialValue
        }
#if os(iOS)
        let available = availableBytes ?? UInt64(os_proc_available_memory())
#else
        let available = availableBytes ?? UInt64.max
#endif
        try checkDrawingMemory(strokeCount: strokes.count, controlPointCount: points, availableBytes: available)
    }

    /// A known base64 lower bound can reject an unreadable archive before a
    /// second huge Foundation allocation. Metadata is still checked after encode.
    static func validateNativeEncodedSize(_ nativeBytes: Int) throws {
        guard nativeBytes >= 0 else { throw EncodingFailure.tooLarge }
        let count = UInt64(nativeBytes)
        let plus = count.addingReportingOverflow(2)
        guard !plus.overflow else { throw EncodingFailure.tooLarge }
        let base64 = (plus.partialValue / 3).multipliedReportingOverflow(by: 4)
        guard !base64.overflow, base64.partialValue <= UInt64(BoardReadLoader.maximumBytes) else {
            throw EncodingFailure.tooLarge
        }
    }

    private static let worker = DispatchQueue(label: "InkSpace.board-save-preparation", qos: .utility)

    static func drawingData(_ drawing: PKDrawing, probe: BoardLassoMemoryProbe.Context? = nil) async throws -> Data {
        BoardLassoMemoryProbe.mark(probe, .archiveLease, .begin)
        return try await withInkMemoryLease {
            BoardLassoMemoryProbe.mark(probe, .archiveLease, .end)
            try Task.checkCancellation()
            BoardLassoMemoryProbe.mark(probe, .archiveWorkerQueued, .point)
            let bytes: Data = try await withCheckedThrowingContinuation { continuation in
                worker.async {
                    BoardLassoMemoryProbe.mark(probe, .archiveWorker, .begin)
                    defer { BoardLassoMemoryProbe.mark(probe, .archiveWorker, .end) }
                    continuation.resume(with: Result { try autoreleasepool {
                        // The lease is already held and this is the last possible
                        // check before PencilKit's non-recoverable ObjC allocation.
                        BoardLassoMemoryProbe.mark(probe, .archiveMemoryCheck, .begin)
                        try checkDrawingMemory(drawing)
                        BoardLassoMemoryProbe.mark(probe, .archiveMemoryCheck, .end)
                        BoardLassoMemoryProbe.mark(probe, .nativeArchive, .begin)
                        let data = drawing.dataRepresentation()
                        BoardLassoMemoryProbe.mark(probe, .nativeArchive, .end, value: UInt64(data.count))
                        return data
                    } })
                }
            }
            try Task.checkCancellation()
            BoardLassoMemoryProbe.mark(probe, .archiveReturn, .point, value: UInt64(bytes.count))
            return bytes
        }
    }

    static func encode(_ document: BoardDocument, probe: BoardLassoMemoryProbe.Context? = nil) async throws -> Data {
        BoardLassoMemoryProbe.mark(probe, .encodeLease, .begin)
        return try await withInkMemoryLease {
            BoardLassoMemoryProbe.mark(probe, .encodeLease, .end)
            try Task.checkCancellation()
            BoardLassoMemoryProbe.mark(probe, .encodeWorkerQueued, .point)
            let bytes: Data = try await withCheckedThrowingContinuation { continuation in
                worker.async {
                    BoardLassoMemoryProbe.mark(probe, .encodeWorker, .begin)
                    defer { BoardLassoMemoryProbe.mark(probe, .encodeWorker, .end) }
                    continuation.resume(with: Result { try autoreleasepool {
                        BoardLassoMemoryProbe.mark(probe, .encodeMemoryCheck, .begin)
                        try validateNativeEncodedSize(document.drawing?.count ?? 0)
#if os(iOS)
                        try checkEncodingMemory(document, availableBytes: UInt64(os_proc_available_memory()))
#endif
                        BoardLassoMemoryProbe.mark(probe, .encodeMemoryCheck, .end)
                        BoardLassoMemoryProbe.mark(probe, .jsonEncode, .begin)
                        let bytes = try document.encode()
                        BoardLassoMemoryProbe.mark(probe, .jsonEncode, .end, value: UInt64(bytes.count))
                        BoardLassoMemoryProbe.mark(probe, .encodedSizeCheck, .begin)
                        try validateEncodedSize(bytes.count)
                        BoardLassoMemoryProbe.mark(probe, .encodedSizeCheck, .end)
                        return bytes
                    } })
                }
            }
            try Task.checkCancellation()
            BoardLassoMemoryProbe.mark(probe, .encodeReturn, .point, value: UInt64(bytes.count))
            return bytes
        }
    }
}
