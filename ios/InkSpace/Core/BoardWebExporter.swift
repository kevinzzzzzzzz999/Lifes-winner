import Foundation
import PencilKit
import UIKit
#if os(iOS)
import os
#endif

struct BoardInkExport {
    /// Flattened native data only when needWorldDrawingData was requested.
    /// Otherwise this is the unchanged authoritative input, not grouped ink.
    var worldDrawingData: Data
    var webInk: BoardWebInk?
    var warning: String?
    var lastInkLocation: BoardInkLocation? = nil
    var boardOnlyPDFPages: [String: Set<Int>] = [:]
}

enum BoardWebExporter {
    enum Failure: Error, LocalizedError {
        case memoryPressure
        var errorDescription: String? {
            String(localized: "当前可用内存不足，笔迹原稿仍保留；手写预览和 PDF 批注同步尚未完成，请稍后重试。")
        }
    }
    private static let worker = DispatchQueue(label: "InkSpace.web-ink", qos: .utility)

    /// Before decode reserve native working objects as well as their encoded
    /// source. Flattening is a separate, later allocation with its own check.
    static func requiredNativeHeadroom(encodedBytes: Int, serializing: Bool = false) -> UInt64 {
        guard encodedBytes >= 0 else { return .max }
        let (cost, overflow) = UInt64(encodedBytes).multipliedReportingOverflow(by: serializing ? 4 : 8)
        let (required, reserveOverflow) = cost.addingReportingOverflow(128 * 1024 * 1024)
        return overflow || reserveOverflow ? .max : required
    }

    static func checkMemory(requiredBytes: UInt64, availableMemoryBytes: UInt64? = nil) throws {
        var available = availableMemoryBytes
#if os(iOS)
        if available == nil { available = UInt64(os_proc_available_memory()) }
#endif
        guard requiredBytes != .max, available.map({ $0 >= requiredBytes }) ?? true else { throw Failure.memoryPressure }
        try Task.checkCancellation()
    }

    /// A supplied native snapshot must be the exact immutable snapshot from
    /// which drawingData was prepared. This is an internal pairing contract:
    /// Store captures both from one native revision before awaiting export.
    /// Callers with data alone keep the validating PencilKit decode path.
    /// Do not reserialize a snapshot merely to check this pairing; that would
    /// recreate the large allocation this reuse is intended to avoid.
    static func export(drawingData: Data, nativeDrawingSnapshot: PKDrawing? = nil,
                       items: [BoardItem], canvasSize: Double = 8_000_000,
                       needWorldDrawingData: Bool = true, availableMemoryBytes: UInt64? = nil) async throws -> BoardInkExport {
        try Task.checkCancellation()
        let result: BoardInkExport = try await withCheckedThrowingContinuation { continuation in
            worker.async {
                continuation.resume(with: Result { try autoreleasepool {
                    var encodedBytes = drawingData.count
                    let groups = items.filter { $0.kind == .inkGroup && $0.inkData != nil }
                    for item in groups {
                        let (sum, overflow) = encodedBytes.addingReportingOverflow(item.inkData!.count)
                        guard !overflow else { throw Failure.memoryPressure }
                        encodedBytes = sum
                    }
                    try checkMemory(requiredBytes: requiredNativeHeadroom(encodedBytes: encodedBytes), availableMemoryBytes: availableMemoryBytes)
                    let baseDrawing: PKDrawing
                    if let nativeDrawingSnapshot {
                        baseDrawing = nativeDrawingSnapshot
                    } else {
                        baseDrawing = try PKDrawing(data: drawingData)
                    }
                    var strokes = baseDrawing.strokes
                    for item in groups {
                        try Task.checkCancellation()
                        let groupStrokes = try autoreleasepool {
                            let group = try PKDrawing(data: item.inkData!)
                            return group.transformed(using: .init(translationX: item.x, y: item.y)).strokes
                        }
                        strokes.append(contentsOf: groupStrokes)
                    }
                    if !groups.isEmpty {
                        try checkMemory(requiredBytes: requiredNativeHeadroom(encodedBytes: encodedBytes, serializing: true), availableMemoryBytes: availableMemoryBytes)
                    }
                    let worldDrawing = groups.isEmpty ? baseDrawing : PKDrawing(strokes: strokes)
                    let world: Data
                    if needWorldDrawingData && !groups.isEmpty {
                        try checkMemory(requiredBytes: requiredNativeHeadroom(encodedBytes: encodedBytes, serializing: true), availableMemoryBytes: availableMemoryBytes)
                        world = autoreleasepool { worldDrawing.dataRepresentation() }
                    } else {
                        // Store already serialized this exact drawing. Repeating
                        // that allocation here can abort inside PencilKit before
                        // Swift can return a recoverable preview error.
                        world = drawingData
                    }
                    let location = BoardInkLocator.location(drawing: worldDrawing, items: [], canvasSize: canvasSize)
                    let boardOnlyPDFPages = BoardPDFInkCoverage.boardOnlyPages(strokes: strokes, items: items)
                    // Adapt sampling density before giving up a derived preview. Never
                    // truncate the editable PencilKit drawing to fit a browser budget.
                    for spacing in [2.0, 4, 8, 16, 32] {
                        try checkMemory(requiredBytes: 192 * 1024 * 1024, availableMemoryBytes: availableMemoryBytes)
                        if let webInk = autoreleasepool(invoking: { makeWebInk(strokes: strokes, spacing: spacing) }) {
                            return BoardInkExport(worldDrawingData: world, webInk: webInk, warning: nil,
                                lastInkLocation: location, boardOnlyPDFPages: boardOnlyPDFPages)
                        }
                    }
                    return BoardInkExport(worldDrawingData: world, webInk: nil,
                        warning: String(localized: "笔迹已完整保存；当前笔迹量超过 Obsidian 手写预览上限。"),
                        lastInkLocation: location)
                } })
            }
        }
        // The GCD worker has no Swift task context. Discard a derived result
        // if its awaiting task was cancelled while that work was in progress.
        try Task.checkCancellation()
        return result
    }

    private static func validTime(_ value: Double) -> Double? {
        value.isFinite && value > 0 && value < 32_503_680_000 ? value : nil
    }
    private static func validDuration(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }; return min(value, 86_400)
    }

    private static func makeWebInk(strokes: [PKStroke], spacing: CGFloat) -> BoardWebInk? {
        var result = BoardWebInk()
        var total = 0
        var totalClipCommands = 0
        for stroke in strokes where !stroke.path.isEmpty {
            let color = stroke.ink.color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1
            guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
            let hex = String(format: "#%02X%02X%02X", Int(min(1, max(0, r)) * 255),
                             Int(min(1, max(0, g)) * 255), Int(min(1, max(0, b)) * 255))
            let scale = sqrt(abs(stroke.transform.a * stroke.transform.d - stroke.transform.b * stroke.transform.c))
            var clipPath: [[Double]]?
            let isFill = BoardWebClipPath.isAuxiliaryFill(stroke)
            if isFill, let mask = stroke.mask {
                guard let commands = BoardWebClipPath.commands(from: mask.cgPath, transform: stroke.transform) else { return nil }
                totalClipCommands += commands.count
                guard totalClipCommands <= BoardWebClipPath.maximumTotalCommands else { return nil }
                clipPath = commands
            }
            // Auxiliary fills need a two-dimensional boundary. Existing erased
            // freehand strokes retain their established sampling path and budget.
            let ranges = stroke.mask == nil || clipPath != nil ? [0...CGFloat(stroke.path.count - 1)] : stroke.maskedPathRanges
            for range in ranges {
                var points: [[Double]] = []
                var opacity: CGFloat = 0
                var firstOffset: Double?
                var lastOffset: Double?
                for point in stroke.path.interpolatedPoints(in: range, by: .distance(spacing)) {
                    let position = point.location.applying(stroke.transform)
                    let width = max(0.01, (point.size.width + point.size.height) * 0.5 * scale)
                    guard [position.x, position.y, width, point.opacity].allSatisfy(\.isFinite),
                          abs(position.x) <= 8_000_000, abs(position.y) <= 8_000_000, width <= 10_000 else { return nil }
                    if firstOffset == nil { firstOffset = point.timeOffset }; lastOffset = point.timeOffset
                    points.append([Double(position.x), Double(position.y), Double(width)])
                    opacity += point.opacity
                    total += 1
                    guard total <= 1_000_000, points.count <= 50_000 else { return nil }
                }
                guard !points.isEmpty else { continue }
                result.strokes.append(BoardWebStroke(points: points, color: hex,
                    opacity: Double(min(1, max(0, a * opacity / CGFloat(points.count)))),
                    startedAt: validTime(stroke.path.creationDate.timeIntervalSince1970 + (firstOffset ?? 0)),
                    duration: validDuration(lastOffset.map { max(0, $0 - (firstOffset ?? 0)) }),
                    clipPath: clipPath))
                guard result.strokes.count <= 50_000 else { return nil }
            }
        }
        return result
    }
}
