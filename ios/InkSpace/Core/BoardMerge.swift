import Foundation
import CoreGraphics
import PencilKit
import CryptoKit
import Darwin
#if os(iOS)
import os
#endif
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

enum BoardMergePlacement: String, CaseIterable, Identifiable, Sendable {
    case below, right
    var id: String { rawValue }
    var title: String { self == .below ? String(localized: "放在目标内容下方") : String(localized: "放在目标内容右侧") }
}

enum BoardMergeMode: String, CaseIterable, Identifiable, Sendable {
    case intoTarget, newCopy
    var id: String { rawValue }
    var title: String { self == .intoTarget ? String(localized: "合入现有目标白板") : String(localized: "生成合并副本") }
}

enum BoardMergeError: LocalizedError {
    case invalid, sameBoard, changed, undoChanged, tooLarge, outputTooLarge, noSpace, webOnly, pdfConflict, sidecar, unavailable, memoryPressure, recovery(String)
    var errorDescription: String? {
        switch self {
        case .invalid: String(localized: "白板格式或关联标识无效，没有覆盖原文件。")
        case .sameBoard: String(localized: "请选择两张不同的白板，不能将同一白板合并两次。")
        case .changed: String(localized: "白板或附属记录已被修改，请重新检查合并预览；原件保留。")
        case .undoChanged: String(localized: "合并后白板、附属记录或备份已改变，不能安全撤销。没有覆盖后续修改，源白板和合并备份仍保留。")
        case .tooLarge: String(localized: "合并内容超过安全处理容量，请拆分白板后再合并；没有截断内容。")
        case .outputTooLarge: String(localized: "完整合并结果超过 Mac 兼容的 64 MiB 上限，尚未合并。请分成较小白板后再合并；不会截断内容或降低笔迹精度。")
        case .noSpace: String(localized: "这个方向没有足够空间，请改选另一个方向；不会缩小或覆盖已有笔迹。")
        case .webOnly: String(localized: "这张白板只有网页笔迹，没有可编辑的原生笔迹。请先在 Mac 转换笔迹后再合并，避免遗漏。")
        case .pdfConflict: String(localized: "两张白板关联的同一 PDF 版本不同，请先同步文件后再合并。")
        case .sidecar: String(localized: "附属胶带、批注或复习记录无法完整读取，已停止合并，原件保留。")
        case .unavailable: String(localized: "合并文件暂不可用，请检查文件夹授权、iCloud 下载和可用空间。")
        case .memoryPressure: String(localized: "当前可用内存不足，尚未合并，两张原件保留。请暂时关闭其他大型文档后重试，也可以在 Mac 合并后从 iPad 打开。")
        case .recovery(let path): String(localized: "合并未完整完成，已暂停自动保存。请保留原文件，并查看恢复记录：\(path)")
        }
    }
}

struct BoardMergeCounts: Codable, Sendable {
    var items: Int; var nativeStrokes: Int; var webStrokes: Int
    var pins: Int; var edges: Int; var printFrames: Int
    var tapes: Int; var reviews: Int; var studyEvents: Int
}

struct BoardMergePreview: Identifiable, Sendable {
    let id: UUID
    let sourcePath: String; let targetPath: String; let outputPath: String
    let sourceTitle: String; let targetTitle: String
    let sourceSHA256: String; let targetSHA256: String
    let mode: BoardMergeMode; let placement: BoardMergePlacement
    let counts: BoardMergeCounts
    let translationX: Double; let translationY: Double
    let sourceBounds: CGRect; let placedBounds: CGRect
}

struct BoardMergeResult: Sendable {
    let id: UUID
    let outputPath: String; let backupPath: String
    let outputSHA256: String; let journalSHA256: String; let counts: BoardMergeCounts
    let importedBounds: CGRect
}

struct BoardMergeUndoResult: Sendable {
    let restoredPath: String; let restoredSHA256: String
    let removedOutputPath: String?; let backupPath: String
}

/// Only this worker touches merge files. The source is read-only. Replacing a
/// target is a journalled, SHA-checked transaction with the main JSON published
/// last; a failed rollback never overwrites another writer's newer contents.
actor BoardMergeService {
    static let maximumBoardBytes = 256 * 1024 * 1024
    static let maximumMergedBytes = 64 * 1024 * 1024
    static func checkMergedBytes(_ count: Int) throws {
        guard count >= 0, count <= maximumMergedBytes else { throw BoardMergeError.outputTooLarge }
    }
    static func requiredMemoryHeadroom(sourceBytes: UInt64, targetBytes: UInt64) throws -> UInt64 {
        let (sum, sumOverflow) = sourceBytes.addingReportingOverflow(targetBytes)
        let (graphs, graphOverflow) = sum.multipliedReportingOverflow(by: 10)
        let (required, reserveOverflow) = graphs.addingReportingOverflow(128 * 1024 * 1024)
        guard !sumOverflow, !graphOverflow, !reserveOverflow else { throw BoardMergeError.tooLarge }
        return required
    }
    static func checkMemory(sourceBytes: UInt64, targetBytes: UInt64, availableBytes: UInt64) throws {
        guard availableBytes >= (try requiredMemoryHeadroom(sourceBytes: sourceBytes, targetBytes: targetBytes)) else { throw BoardMergeError.memoryPressure }
    }
    private var prepared: Prepared?
    private struct FileSnapshot { var path: String; var data: Data?; var hash: String? }
    private struct Inventory: Codable { var path: String; var names: [String] }
    private struct Write { var path: String; var data: Data; var original: Data? }
    private struct Prepared {
        var preview: BoardMergePreview; var root: URL; var reads: [FileSnapshot]
        var inventories: [Inventory]; var writes: [Write]; var references: Set<String>; var importedBounds: CGRect
    }
    private struct Input {
        var board: BoardDocument; var json: [String: Any]; var bytes: Data
        var drawing: PKDrawing; var tapes: BoardWritingAidTapeDocument?
        var tapeJSON: [String: Any]?; var events: [(StudyEvent, [String: Any])]
        var reviews: [(BoardReview, [String: Any], Data?)]
    }
    private struct Journal: Codable {
        struct File: Codable { var path: String; var beforeSHA256: String?; var afterSHA256: String; var original: String?; var staged: String }
        struct ReadFile: Codable { var path: String; var sha256: String?; var original: String? }
        var version = 1; var id: UUID; var phase: String; var sourcePath: String; var targetPath: String
        var sourceSHA256: String; var targetSHA256: String; var outputPath: String
        var sourceOriginal = "originals/source.inkspace.json"; var targetOriginal = "originals/target.inkspace.json"
        var files: [File]; var readFiles: [ReadFile] = []; var recoveryRequired = false
        var inventoriesBefore: [Inventory]?; var inventoriesAfter: [Inventory]?
    }
#if INKSPACE_BOARD_MERGE_TESTING
    private var failAfterPublications: Int?
    private var replaceAtFailure: Data?
    private var failUndoAfterRestorations: Int?
    private var replaceAtUndoFailure: Data?
    func setTestFailure(after publications: Int, replacement: Data? = nil) {
        failAfterPublications = publications; replaceAtFailure = replacement
    }
    func setTestUndoFailure(after restorations: Int, replacement: Data? = nil) {
        failUndoAfterRestorations = restorations; replaceAtUndoFailure = replacement
    }
#endif

    func discard() { prepared = nil }

    func prepare(root inputRoot: URL, sourcePath: String, targetPath: String,
                 placement: BoardMergePlacement, mode: BoardMergeMode, position: CGPoint? = nil) throws -> BoardMergePreview {
        prepared = nil
        let access = inputRoot.startAccessingSecurityScopedResource()
        defer { if access { inputRoot.stopAccessingSecurityScopedResource() } }
        let root = inputRoot.standardizedFileURL.resolvingSymlinksInPath()
        try Self.directory(root)
        guard sourcePath != targetPath else { throw BoardMergeError.sameBoard }
        guard sourcePath.lowercased().hasSuffix(".inkspace.json"), targetPath.lowercased().hasSuffix(".inkspace.json") else { throw BoardMergeError.invalid }
        try Self.preflightMemory(root: root, sourcePath: sourcePath, targetPath: targetPath)
        var failure: NSError?; var result: Result<Prepared, Error> = .failure(BoardMergeError.unavailable)
        NSFileCoordinator().coordinate(readingItemAt: root, options: [], error: &failure) { coordinated in
            result = Result {
                try Self.rejectUnfinished(root: coordinated, sourcePath: sourcePath, targetPath: targetPath)
                try Self.preflightMemory(root: coordinated, sourcePath: sourcePath, targetPath: targetPath)
                // Preview retains only original/output byte snapshots and small
                // summaries. Raw Foundation JSON graphs and PKDrawing temporaries
                // are drained before the actor returns to the presentation.
                return try autoreleasepool { try self.makePlan(root: coordinated, sourcePath: sourcePath, targetPath: targetPath, placement: placement, mode: mode, position: position) }
            }
        }
        if let failure { throw failure }
        let value = try result.get(); prepared = value
        return value.preview
    }

    func commit(_ id: UUID) throws -> BoardMergeResult {
        guard let plan = prepared, plan.preview.id == id else { throw BoardMergeError.changed }
        prepared = nil // A transaction is never repeated with stale inputs.
        let access = plan.root.startAccessingSecurityScopedResource()
        defer { if access { plan.root.stopAccessingSecurityScopedResource() } }
        try Self.preflightMemory(root: plan.root, sourcePath: plan.preview.sourcePath, targetPath: plan.preview.targetPath)
        var failure: NSError?; var result: Result<BoardMergeResult, Error> = .failure(BoardMergeError.unavailable)
        NSFileCoordinator().coordinate(writingItemAt: plan.root, options: .forMerging, error: &failure) { root in
            result = Result {
                try Self.preflightMemory(root: root, sourcePath: plan.preview.sourcePath, targetPath: plan.preview.targetPath)
                return try autoreleasepool { try self.publish(plan, root: root) }
            }
        }
        if let failure { throw failure }
        return try result.get()
    }

    /// Dedicated compound undo, deliberately separate from PencilKit's local
    /// stroke undo stack. The receipt binds the exact complete journal; every
    /// published file and directory inventory must still match before any write.
    func undoLastBoardMerge(root inputRoot: URL, result receipt: BoardMergeResult) throws -> BoardMergeUndoResult {
        prepared = nil
        let access = inputRoot.startAccessingSecurityScopedResource()
        defer { if access { inputRoot.stopAccessingSecurityScopedResource() } }
        let root = inputRoot.standardizedFileURL.resolvingSymlinksInPath()
        try Self.directory(root)
        var failure: NSError?; var result: Result<BoardMergeUndoResult, Error> = .failure(BoardMergeError.unavailable)
        NSFileCoordinator().coordinate(writingItemAt: root, options: .forMerging, error: &failure) { coordinated in
            result = Result { try autoreleasepool { try self.undo(receipt, root: coordinated) } }
        }
        if let failure { throw failure }
        return try result.get()
    }

    private func undo(_ receipt: BoardMergeResult, root: URL) throws -> BoardMergeUndoResult {
        try Task.checkCancellation()
        let backupPath = ".inkspace/merge-history/" + receipt.id.uuidString.lowercased()
        guard receipt.backupPath == backupPath,
              let bytes = try Self.read(root: root, path: backupPath + "/journal.json", limit: 16 * 1024 * 1024),
              Self.hash(bytes) == receipt.journalSHA256 else { throw BoardMergeError.undoChanged }
        var journal = try JSONDecoder().decode(Journal.self, from: bytes)
        guard journal.version == 1, journal.id == receipt.id, journal.phase == "complete", !journal.recoveryRequired,
              journal.outputPath == receipt.outputPath, journal.files.last?.path == receipt.outputPath,
              journal.files.last?.afterSHA256 == receipt.outputSHA256,
              journal.files.count <= 40_001, Set(journal.files.map(\.path)).count == journal.files.count,
              journal.sourcePath != journal.targetPath, journal.sourcePath != journal.outputPath,
              journal.sourceOriginal == "originals/source.inkspace.json", journal.targetOriginal == "originals/target.inkspace.json",
              let inventoriesBefore = journal.inventoriesBefore, let inventoriesAfter = journal.inventoriesAfter else { throw BoardMergeError.undoChanged }
        try Self.preflightMemory(root: root, sourcePath: journal.sourcePath, targetPath: journal.outputPath)
        let intoTarget = journal.outputPath == journal.targetPath
        func snapshot(_ relative: String, expected: String, cancellable: Bool = true) throws -> Data {
            guard let data = try Self.read(root: root, path: backupPath + "/" + relative, limit: Self.maximumBoardBytes, cancellable: cancellable),
                  Self.hash(data) == expected else { throw BoardMergeError.undoChanged }
            return data
        }
        // A changed source is never overwritten, and an altered original backup
        // can never be substituted for the target that the user actually merged.
        _ = try snapshot(journal.sourceOriginal, expected: journal.sourceSHA256)
        _ = try snapshot(journal.targetOriginal, expected: journal.targetSHA256)
        guard intoTarget ? journal.files.last?.beforeSHA256 == journal.targetSHA256 : journal.files.last?.beforeSHA256 == nil else { throw BoardMergeError.undoChanged }
        for (index, file) in journal.files.enumerated() {
            guard file.path != journal.sourcePath, VaultPath.isSafeRelative(file.path),
                  file.staged == "staged/\(index).json",
                  file.original == (file.beforeSHA256 == nil ? nil : "originals/write-\(index).json") else { throw BoardMergeError.undoChanged }
            _ = try snapshot(file.staged, expected: file.afterSHA256)
            if let original = file.original, let expected = file.beforeSHA256 { _ = try snapshot(original, expected: expected) }
        }
        // Restore content, never an older synchronization revision. Original
        // backups remain exact bytes; only the newly published restore gets a
        // fresh writer/time and revisions newer than the merged versions.
        var restorations: [String: Data] = [:]
        let restoredAt = ISO8601DateFormatter().string(from: Date()), restoreWriter = UUID().uuidString.lowercased()
        for file in journal.files {
            guard let original = file.original, let expected = file.beforeSHA256 else { continue }
            let originalBytes = try snapshot(original, expected: expected)
            if file.path == journal.outputPath && intoTarget {
                restorations[file.path] = try autoreleasepool {
                    var raw = try Self.object(originalBytes)
                    let merged = try Self.object(snapshot(file.staged, expected: file.afterSHA256))
                    guard let prior = raw["revision"] as? Int, let mergedRevision = merged["revision"] as? Int,
                          prior >= 0, mergedRevision >= prior, mergedRevision < Int.max else { throw BoardMergeError.undoChanged }
                    raw["revision"] = mergedRevision + 1; raw["writerID"] = restoreWriter; raw["updatedAt"] = restoredAt
                    let bytes = try Self.json(raw); try Self.checkMergedBytes(bytes.count)
                    _ = try BoardDocument.decode(bytes)
                    return bytes
                }
            } else if file.path.hasPrefix(".inkspace/writing-aids/") {
                let prior = try JSONDecoder().decode(BoardWritingAidTapeDocument.self, from: originalBytes)
                let merged = try JSONDecoder().decode(BoardWritingAidTapeDocument.self, from: snapshot(file.staged, expected: file.afterSHA256))
                guard prior.boardID == merged.boardID, merged.revision >= prior.revision, merged.revision < UInt64.max else { throw BoardMergeError.undoChanged }
                var raw = try Self.object(originalBytes); raw["revision"] = NSNumber(value: merged.revision + 1)
                let bytes = try Self.json(raw)
                try JSONDecoder().decode(BoardWritingAidTapeDocument.self, from: bytes).validate()
                restorations[file.path] = bytes
            } else { restorations[file.path] = originalBytes }
        }
        let restoredHashes = restorations.mapValues(Self.hash)
        func checkOriginals() throws {
            guard try Self.read(root: root, path: journal.sourcePath, limit: Self.maximumBoardBytes).map(Self.hash) == journal.sourceSHA256 else { throw BoardMergeError.undoChanged }
            if !intoTarget {
                guard try Self.read(root: root, path: journal.targetPath, limit: Self.maximumBoardBytes).map(Self.hash) == journal.targetSHA256 else { throw BoardMergeError.undoChanged }
            }
        }
        func checkInventories(_ values: [Inventory]) throws {
            for value in values { guard try Self.names(root: root, path: value.path) == value.names else { throw BoardMergeError.undoChanged } }
        }
        try checkOriginals(); try checkInventories(inventoriesAfter)
        for file in journal.files {
            guard try Self.read(root: root, path: file.path, limit: Self.maximumBoardBytes, optional: true).map(Self.hash) == file.afterSHA256 else { throw BoardMergeError.undoChanged }
        }
        let backup = try Self.fileURL(root: root, path: backupPath + "/journal.json", mustExist: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        func saveJournal() throws { try encoder.encode(journal).write(to: backup, options: .atomic) }
        var restored = 0
        do {
            journal.phase = "undoing"; try saveJournal()
            for file in journal.files {
                try Task.checkCancellation()
                if file.path == journal.outputPath {
                    try checkOriginals(); try checkInventories(inventoriesBefore)
                    for sidecar in journal.files.dropLast() {
                        guard try Self.read(root: root, path: sidecar.path, limit: Self.maximumBoardBytes, optional: true).map(Self.hash) == restoredHashes[sidecar.path] else { throw BoardMergeError.undoChanged }
                    }
                }
                if let restored = restorations[file.path] {
                    try Self.replace(root: root, path: file.path, data: restored, expected: file.afterSHA256)
                } else {
                    guard try Self.read(root: root, path: file.path, limit: Self.maximumBoardBytes).map(Self.hash) == file.afterSHA256 else { throw BoardMergeError.undoChanged }
                    try FileManager.default.removeItem(at: Self.fileURL(root: root, path: file.path, mustExist: true))
                }
                restored += 1
#if INKSPACE_BOARD_MERGE_TESTING
                if let failUndoAfterRestorations, restored == failUndoAfterRestorations {
                    if let replaceAtUndoFailure { try replaceAtUndoFailure.write(to: root.appendingPathComponent(file.path), options: .atomic) }
                    throw BoardMergeError.unavailable
                }
#endif
            }
            journal.phase = "undone"; try saveJournal()
            return BoardMergeUndoResult(restoredPath: journal.targetPath, restoredSHA256: restoredHashes[journal.targetPath] ?? journal.targetSHA256,
                removedOutputPath: intoTarget ? nil : journal.outputPath, backupPath: backupPath)
        } catch {
            // Undo itself is transactional. If interrupted, roll forward to the
            // complete merged state, never overwrite an external later edit.
            var unsafe = false
            for file in journal.files {
                do {
                    let current = try Self.read(root: root, path: file.path, limit: Self.maximumBoardBytes, optional: true, cancellable: false).map(Self.hash)
                    if current == file.afterSHA256 { continue }
                    guard current == restoredHashes[file.path] else { unsafe = true; continue }
                    try Self.replace(root: root, path: file.path, data: snapshot(file.staged, expected: file.afterSHA256, cancellable: false), expected: restoredHashes[file.path], cancellable: false)
                } catch { unsafe = true }
            }
            journal.phase = unsafe ? "undo-recovery-required" : "complete"; journal.recoveryRequired = unsafe
            do { try saveJournal() } catch { unsafe = true }
            if unsafe { throw BoardMergeError.recovery(backupPath + "/journal.json") }
            throw error
        }
    }

    private func makePlan(root: URL, sourcePath: String, targetPath: String,
                          placement: BoardMergePlacement, mode: BoardMergeMode, position: CGPoint?) throws -> Prepared {
        try Task.checkCancellation()
        var reads: [FileSnapshot] = [], inventories: [Inventory] = []
        func snapshot(_ path: String, limit: Int, optional: Bool = false) throws -> Data? {
            let data = try Self.read(root: root, path: path, limit: limit, optional: optional)
            reads.append(.init(path: path, data: data, hash: data.map(Self.hash))); return data
        }
        func inventory(_ path: String) throws -> [String] {
            let names = try Self.names(root: root, path: path)
            inventories.append(.init(path: path, names: names)); return names
        }
        func input(_ path: String) throws -> Input {
            guard let bytes = try snapshot(path, limit: Self.maximumBoardBytes) else { throw BoardMergeError.unavailable }
            let board = try BoardDocument.decode(bytes)
            let rawBoard = try Self.object(bytes)
            for category in ["items", "edges", "pins", "printFrames"] {
                let values = rawBoard[category] as? [[String: Any]] ?? []
                let ids = values.compactMap { ($0["id"] as? String).flatMap(UUID.init(uuidString:)) }
                guard ids.count == values.count, Set(ids).count == ids.count else { throw BoardMergeError.invalid }
            }
            let drawing = try board.drawing.map(PKDrawing.init(data:)) ?? PKDrawing()
            if drawing.strokes.isEmpty, !(board.webInk?.strokes.isEmpty ?? true),
               !board.items.contains(where: { $0.kind == .inkGroup }) { throw BoardMergeError.webOnly }
            for item in board.items where item.kind == .inkGroup {
                if let data = item.inkData { _ = try PKDrawing(data: data) }
                else { throw BoardMergeError.invalid }
            }
            let tapePath = Self.tapePath(board.id)
            let tapeBytes = try snapshot(tapePath, limit: BoardWritingAidTapeDocument.maximumBytes, optional: true)
            let tapes = try tapeBytes.map { try JSONDecoder().decode(BoardWritingAidTapeDocument.self, from: $0) }
            if let tapes { guard tapes.boardID == board.id else { throw BoardMergeError.sidecar }; try tapes.validate() }
            let eventsPath = ".inkspace-study/" + board.id.uuidString.lowercased() + "/events"
            let names = try inventory(eventsPath)
            guard names.count <= 10_000 else { throw BoardMergeError.tooLarge }
            var events: [(StudyEvent, [String: Any])] = [], total = 0
            for name in names {
                guard name.hasSuffix(".json"), let fileID = UUID(uuidString: String(name.dropLast(5))),
                      let data = try snapshot(eventsPath + "/" + name, limit: 65_536) else { throw BoardMergeError.sidecar }
                total += data.count; guard total <= 32 * 1024 * 1024 else { throw BoardMergeError.tooLarge }
                let event = try StudyEvent.decode(data)
                guard event.id == fileID.uuidString.lowercased(), event.boardID == board.id.uuidString.lowercased() else { throw BoardMergeError.sidecar }
                events.append((event, try Self.object(data)))
            }
            _ = try StudyProjection.cards(events.map(\.0))
            return Input(board: board, json: rawBoard, bytes: bytes, drawing: drawing, tapes: tapes,
                tapeJSON: try tapeBytes.map(Self.object), events: events, reviews: [])
        }
        var target = try input(targetPath), source = try input(sourcePath)
        guard source.board.id != target.board.id else { throw BoardMergeError.sameBoard }
        // Tombstones are copied with their records; deleted comments never return.
        let reviewNames = try inventory(".inkspace-reviews")
        guard reviewNames.count <= 20_000 else { throw BoardMergeError.tooLarge }
        var reviewBytes: [String: Data] = [:], reviewTotal = 0
        for name in reviewNames {
            guard name.hasSuffix(".json"), let bytes = try snapshot(".inkspace-reviews/" + name, limit: 128 * 1024) else { throw BoardMergeError.sidecar }
            reviewTotal += bytes.count; guard reviewTotal <= 32 * 1024 * 1024 else { throw BoardMergeError.tooLarge }
            reviewBytes[name.lowercased()] = bytes
        }
        for name in reviewNames where !name.lowercased().hasSuffix(".deleted.json") {
            guard let bytes = reviewBytes[name.lowercased()], let fileID = UUID(uuidString: String(name.dropLast(5))) else { throw BoardMergeError.sidecar }
            let review = try JSONDecoder().decode(BoardReview.self, from: bytes); try review.validate()
            guard review.id == fileID else { throw BoardMergeError.sidecar }
            let marker = reviewBytes[review.id.uuidString.lowercased() + ".deleted.json"]
            if let marker {
                let deleted = try JSONDecoder().decode(ReviewDeletion.self, from: marker)
                guard deleted.schemaVersion == 1, deleted.id == review.id, ReviewRepository.isDate(deleted.deletedAt) else { throw BoardMergeError.sidecar }
            }
            if review.boardID == source.board.id {
                guard review.boardPath == sourcePath else { throw BoardMergeError.sidecar }
                source.reviews.append((review, try Self.object(bytes), marker))
            } else if review.boardID == target.board.id {
                guard review.boardPath == targetPath else { throw BoardMergeError.sidecar }
                target.reviews.append((review, try Self.object(bytes), marker))
            }
        }
        let sourceBounds = try Self.bounds(source), targetBounds = try Self.bounds(target)
        let sourceOrigin = sourceBounds.isNull ? CGPoint(x: source.board.viewport.x, y: source.board.viewport.y) : sourceBounds.origin
        let targetOrigin = targetBounds.isNull ? CGPoint(x: target.board.viewport.x, y: target.board.viewport.y) : targetBounds.origin
        let gap = 120.0
        if let position {
            guard position.x.isFinite, position.y.isFinite, position.x >= 0, position.y >= 0,
                  position.x <= 8_000_000, position.y <= 8_000_000 else { throw BoardMergeError.noSpace }
        }
        let dx = position.map { $0.x - sourceOrigin.x } ?? (placement == .right && !targetBounds.isNull ? targetBounds.maxX + gap - sourceOrigin.x : targetOrigin.x - sourceOrigin.x)
        let dy = position.map { $0.y - sourceOrigin.y } ?? (placement == .below && !targetBounds.isNull ? targetBounds.maxY + gap - sourceOrigin.y : targetOrigin.y - sourceOrigin.y)
        let importedBounds = sourceBounds.offsetBy(dx: dx, dy: dy)
        if !importedBounds.isNull {
            guard importedBounds.minX >= 0, importedBounds.minY >= 0,
                  importedBounds.maxX <= 8_000_000, importedBounds.maxY <= 8_000_000 else { throw BoardMergeError.noSpace }
        }
        let operationID = UUID(), outputID = mode == .intoTarget ? target.board.id : UUID()
        let stem = String(targetPath.dropLast(".inkspace.json".count))
        let outputPath = mode == .intoTarget ? targetPath : stem + "-合并-" + operationID.uuidString.prefix(8).lowercased() + ".inkspace.json"
        let remapTarget = mode == .newCopy
        var targetMap: [String: String] = [:], sourceMap: [String: String] = [:]
        func remap(_ old: String, map: inout [String: String], enabled: Bool) throws -> String {
            guard let uuid = UUID(uuidString: old) else { throw BoardMergeError.invalid }
            let key = uuid.uuidString.lowercased()
            if !enabled { return old }
            if let id = map[key] { return id }
            let id = UUID().uuidString.lowercased(); map[key] = id; return id
        }
        func remapped(_ value: [String: Any], dx: Double, dy: Double, map: inout [String: String], enabled: Bool, category: String) throws -> [String: Any] {
            var value = value
            if let id = value["id"] as? String { value["id"] = try remap(id, map: &map, enabled: enabled) }
            else { throw BoardMergeError.invalid }
            if category == "edges" {
                for field in ["from", "to"] {
                    guard let old = value[field] as? String else { throw BoardMergeError.invalid }
                    value[field] = try remap(old, map: &map, enabled: enabled)
                }
            } else {
                try Self.translate(&value, dx: dx, dy: dy)
            }
            if category == "items" {
                if let id = value["sourceCardID"] as? String { value["sourceCardID"] = try remap(id, map: &map, enabled: enabled) }
                if var children = value["childBoards"] as? [[String: Any]] {
                    for index in children.indices {
                        // child.id is the real child's board ID, not an owner-node ID.
                        if var presentation = children[index]["presentation"] as? [String: Any] {
                            try Self.translate(&presentation, dx: dx, dy: dy); children[index]["presentation"] = presentation
                        }
                    }
                    value["childBoards"] = children
                }
            }
            return value
        }
        var output = target.json
        for category in ["items", "edges", "pins", "printFrames"] {
            let a = try (target.json[category] as? [[String: Any]] ?? []).map { try remapped($0, dx: 0, dy: 0, map: &targetMap, enabled: remapTarget, category: category) }
            let b = try (source.json[category] as? [[String: Any]] ?? []).map { try remapped($0, dx: dx, dy: dy, map: &sourceMap, enabled: true, category: category) }
            if !a.isEmpty || !b.isEmpty || output[category] != nil { output[category] = a + b }
        }
        let combinedInk = PKDrawing(strokes: target.drawing.strokes + source.drawing.transformed(using: .init(translationX: dx, y: dy)).strokes)
        guard combinedInk.strokes.count == target.drawing.strokes.count + source.drawing.strokes.count else { throw BoardMergeError.invalid }
        output["drawing"] = combinedInk.dataRepresentation().base64EncodedString()
        let aWeb = try Self.web(target), bWeb = try Self.web(source)
        if !aWeb.isEmpty || !bWeb.isEmpty {
            let strokes = aWeb + (try bWeb.map { try Self.translateWeb($0, dx: dx, dy: dy) })
            guard strokes.count <= 50_000,
                  strokes.reduce(0, { $0 + (($1["points"] as? [[Double]])?.count ?? 0) }) <= 1_000_000,
                  strokes.reduce(0, { $0 + (($1["clipPath"] as? [[Double]])?.count ?? 0) }) <= 100_000 else { throw BoardMergeError.tooLarge }
            output["webInk"] = ["version": 1, "strokes": strokes]
        } else { output.removeValue(forKey: "webInk") }
        let annotationSources = try Self.annotations(target.board.pdfAnnotationSources ?? [], source.board.pdfAnnotationSources ?? [])
        if !annotationSources.isEmpty { output["pdfAnnotationSources"] = annotationSources }
        output["pdfOwnedSourcePaths"] = Array(Set((target.board.pdfOwnedSourcePaths ?? []) + (source.board.pdfOwnedSourcePaths ?? []))).sorted()
        output["pdfWritebackSuspended"] = true // Original boards retain PDF ownership.
        let inheritedOwners = target.board.pdfDisplayOwnerIDs.union(source.board.pdfDisplayOwnerIDs)
        guard inheritedOwners.count <= 128 else { throw BoardMergeError.tooLarge }
        output["pdfMergedOwnerIDs"] = inheritedOwners.map { $0.uuidString.lowercased() }.sorted()
        output["id"] = outputID.uuidString.lowercased(); output["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        guard target.board.revision < Int.max else { throw BoardMergeError.invalid }
        output["revision"] = target.board.revision + 1; output["writerID"] = operationID.uuidString.lowercased()
        output["canvasWidth"] = 8_000_000; output["canvasHeight"] = 8_000_000
        output.removeValue(forKey: "previewPNG")
        if let location = source.json["lastInkLocation"] as? [String: Any] {
            var moved = location; try Self.translate(&moved, dx: dx, dy: dy); output["lastInkLocation"] = moved
        }
        if mode == .newCopy { output["title"] = target.board.title + String(localized: " · 合并") }
        var writes: [Write] = []
        func addWrite(_ path: String, _ data: Data) throws {
            let original = try snapshot(path, limit: Self.maximumBoardBytes, optional: true)
            guard path == targetPath || original == nil else { throw BoardMergeError.changed }
            writes.append(.init(path: path, data: data, original: original))
        }
        if target.tapes != nil || source.tapes != nil {
            var tapeJSON = target.tapeJSON ?? ["version": 1, "boardID": outputID.uuidString.lowercased(), "revision": 0, "tapes": []]
            func tapes(_ input: Input, x: Double, y: Double, map: inout [String: String], enabled: Bool) throws -> [[String: Any]] {
                try (input.tapeJSON?["tapes"] as? [[String: Any]] ?? []).map { value in
                    var value = value
                    guard let old = value["id"] as? String, var points = value["points"] as? [[String: Any]] else { throw BoardMergeError.sidecar }
                    value["id"] = try remap(old, map: &map, enabled: enabled)
                    for i in points.indices { try Self.translate(&points[i], dx: x, dy: y) }; value["points"] = points
                    if let old = value["anchorItemID"] as? String { value["anchorItemID"] = try remap(old, map: &map, enabled: enabled) }
                    return value
                }
            }
            tapeJSON["tapes"] = try tapes(target, x: 0, y: 0, map: &targetMap, enabled: remapTarget) + tapes(source, x: dx, y: dy, map: &sourceMap, enabled: true)
            tapeJSON["boardID"] = outputID.uuidString.lowercased()
            let revision = target.tapes?.revision ?? 0
            guard revision < UInt64.max else { throw BoardMergeError.sidecar }
            tapeJSON["revision"] = mode == .intoTarget ? revision + 1 : 0
            let bytes = try Self.json(tapeJSON)
            let typed = try JSONDecoder().decode(BoardWritingAidTapeDocument.self, from: bytes); try typed.validate()
            guard bytes.count <= BoardWritingAidTapeDocument.maximumBytes else { throw BoardMergeError.tooLarge }
            let path = Self.tapePath(outputID)
            let original = mode == .intoTarget ? reads.first(where: { $0.path == path })?.data : nil
            if mode == .newCopy, try Self.read(root: root, path: path, limit: 4 * 1024 * 1024, optional: true) != nil { throw BoardMergeError.changed }
            writes.append(.init(path: path, data: bytes, original: original))
        }
        func importSidecars(_ input: Input, x: Double, y: Double, map: inout [String: String]) throws {
            var eventMap: [String: String] = [:]
            // Sorting by the old ID retains the tie-break order of equal-time events.
            let events = input.events.sorted { $0.0.createdAt == $1.0.createdAt ? $0.0.id < $1.0.id : $0.0.createdAt < $1.0.createdAt }
            let newIDs = events.map { _ in UUID().uuidString.lowercased() }.sorted()
            for (index, pair) in events.enumerated() { eventMap[pair.0.id] = newIDs[index] }
            for (event, raw) in events {
                var raw = raw
                raw["id"] = eventMap[event.id]!; raw["boardID"] = outputID.uuidString.lowercased()
                raw["itemID"] = try remap(event.itemID, map: &map, enabled: true)
                let bytes = try Self.json(raw); _ = try StudyEvent.decode(bytes)
                try addWrite(".inkspace-study/" + outputID.uuidString.lowercased() + "/events/" + eventMap[event.id]! + ".json", bytes)
            }
            for (review, raw, marker) in input.reviews {
                var raw = raw; let id = UUID().uuidString.lowercased()
                raw["id"] = id; raw["boardID"] = outputID.uuidString.lowercased(); raw["boardPath"] = outputPath
                guard var rect = raw["rect"] as? [String: Any] else { throw BoardMergeError.sidecar }
                try Self.translate(&rect, dx: x, dy: y); raw["rect"] = rect
                if var anchor = raw["anchor"] as? [String: Any], let old = anchor["itemID"] as? String {
                    anchor["itemID"] = try remap(old, map: &map, enabled: true); raw["anchor"] = anchor
                }
                let data = try Self.json(raw); try JSONDecoder().decode(BoardReview.self, from: data).validate()
                try addWrite(".inkspace-reviews/" + id + ".json", data)
                if let marker {
                    var deleted = try Self.object(marker); deleted["id"] = id
                    try addWrite(".inkspace-reviews/" + id + ".deleted.json", Self.json(deleted))
                }
                _ = review
            }
        }
        if remapTarget { try importSidecars(target, x: 0, y: 0, map: &targetMap) }
        try importSidecars(source, x: dx, y: dy, map: &sourceMap)
        let newStudyWrites = writes.filter { $0.path.hasPrefix(".inkspace-study/") }
        guard newStudyWrites.count + (mode == .intoTarget ? target.events.count : 0) <= 10_000,
              newStudyWrites.reduce(0, { $0 + $1.data.count }) + (mode == .intoTarget ? target.events.reduce(0, { $0 + ((try? Self.json($1.1).count) ?? 0) }) : 0) <= 32 * 1024 * 1024 else { throw BoardMergeError.tooLarge }
        let newReviewWrites = writes.filter { $0.path.hasPrefix(".inkspace-reviews/") }
        guard reviewNames.count + newReviewWrites.count <= 20_000,
              reviewTotal + newReviewWrites.reduce(0, { $0 + $1.data.count }) <= 32 * 1024 * 1024 else { throw BoardMergeError.tooLarge }
        let bytes = try Self.json(output)
        try Self.checkMergedBytes(bytes.count)
        _ = try BoardDocument.decode(bytes)
        try addWrite(outputPath, bytes) // Main board is always published last.
        // All attachment and child links remain vault-root-relative. Verify that
        // each referenced file is still a regular in-vault file, never relocate it.
        var references = Set<String>()
        for item in target.board.items + source.board.items {
            references.formUnion([item.sourcePath, item.originalSourcePath, item.sourceReference?.path].compactMap { $0 })
            references.formUnion((item.childBoards ?? []).map(\.path))
        }
        for event in target.events + source.events { references.formUnion(event.0.card?.imagePaths ?? []) }
        for path in references { _ = try Self.fileURL(root: root, path: path, mustExist: true) }
        let counts = BoardMergeCounts(items: source.board.items.count, nativeStrokes: source.drawing.strokes.count,
            webStrokes: bWeb.count, pins: source.board.pins.count, edges: source.board.edges.count,
            printFrames: source.board.printFrames?.count ?? 0, tapes: source.tapes?.tapes.count ?? 0,
            reviews: source.reviews.filter { $0.2 == nil }.count, studyEvents: source.events.count)
        let preview = BoardMergePreview(id: operationID, sourcePath: sourcePath, targetPath: targetPath, outputPath: outputPath,
            sourceTitle: source.board.title, targetTitle: target.board.title, sourceSHA256: Self.hash(source.bytes), targetSHA256: Self.hash(target.bytes),
            mode: mode, placement: placement, counts: counts, translationX: dx, translationY: dy,
            sourceBounds: sourceBounds, placedBounds: importedBounds)
        return Prepared(preview: preview, root: root, reads: reads, inventories: inventories, writes: writes, references: references, importedBounds: importedBounds)
    }

    private func publish(_ plan: Prepared, root: URL) throws -> BoardMergeResult {
        try Task.checkCancellation(); try verify(plan, root: root)
        let backupPath = ".inkspace/merge-history/" + plan.preview.id.uuidString.lowercased()
        let backup = try Self.makeDirectory(root: root, path: backupPath)
        var journal = Journal(id: plan.preview.id, phase: "prepared", sourcePath: plan.preview.sourcePath, targetPath: plan.preview.targetPath,
            sourceSHA256: plan.preview.sourceSHA256, targetSHA256: plan.preview.targetSHA256, outputPath: plan.preview.outputPath, files: [])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        func saveJournal() throws { try encoder.encode(journal).write(to: backup.appendingPathComponent("journal.json"), options: .atomic) }
        _ = try Self.makeDirectory(root: backup, path: "originals")
        _ = try Self.makeDirectory(root: backup, path: "staged")
        // Preserve exact bytes before publication, including unknown JSON fields.
        for (name, path) in [("source.inkspace.json", plan.preview.sourcePath), ("target.inkspace.json", plan.preview.targetPath)] {
            guard let bytes = plan.reads.first(where: { $0.path == path })?.data else { throw BoardMergeError.changed }
            try Self.writeNew(bytes, to: backup.appendingPathComponent("originals/" + name))
        }
        for (index, file) in plan.reads.enumerated() where file.path != plan.preview.sourcePath && file.path != plan.preview.targetPath {
            if let bytes = file.data { try Self.writeNew(bytes, to: backup.appendingPathComponent("originals/read-\(index).json")) }
            journal.readFiles.append(.init(path: file.path, sha256: file.hash, original: file.data == nil ? nil : "originals/read-\(index).json"))
        }
        for (index, write) in plan.writes.enumerated() {
            let staged = "staged/\(index).json", original = write.original == nil ? nil : "originals/write-\(index).json"
            try Self.writeNew(write.data, to: backup.appendingPathComponent(staged))
            if let original, let bytes = write.original { try Self.writeNew(bytes, to: backup.appendingPathComponent(original)) }
            journal.files.append(.init(path: write.path, beforeSHA256: write.original.map(Self.hash), afterSHA256: Self.hash(write.data), original: original, staged: staged))
        }
        journal.inventoriesBefore = plan.inventories
        journal.inventoriesAfter = plan.inventories.map { inventory in
            let added = plan.writes.filter { ($0.path as NSString).deletingLastPathComponent == inventory.path }
                .map { ($0.path as NSString).lastPathComponent }
            return Inventory(path: inventory.path, names: Array(Set(inventory.names).union(added)).sorted())
        }
        try saveJournal(); try verify(plan, root: root)
        var published = 0
        do {
            journal.phase = "publishing"; try saveJournal()
            for write in plan.writes {
                try Task.checkCancellation()
                // Revalidate both board originals immediately before the main commit.
                if write.path == plan.preview.outputPath {
                    try verifyBeforeMain(plan, root: root)
                }
                try Self.replace(root: root, path: write.path, data: write.data, expected: write.original.map(Self.hash))
                published += 1
#if INKSPACE_BOARD_MERGE_TESTING
                if let failAfterPublications, published == failAfterPublications {
                    if let replaceAtFailure { try replaceAtFailure.write(to: root.appendingPathComponent(write.path), options: .atomic) }
                    throw BoardMergeError.unavailable
                }
#endif
            }
            journal.phase = "complete"; try saveJournal()
            guard let final = plan.writes.last else { throw BoardMergeError.invalid }
            return BoardMergeResult(id: plan.preview.id, outputPath: plan.preview.outputPath, backupPath: backupPath,
                outputSHA256: Self.hash(final.data), journalSHA256: Self.hash(try encoder.encode(journal)), counts: plan.preview.counts, importedBounds: plan.importedBounds)
        } catch {
            var unsafe = false
            for write in plan.writes.prefix(min(published + 1, plan.writes.count)).reversed() {
                do {
                    let current = try Self.read(root: root, path: write.path, limit: Self.maximumBoardBytes, optional: true, cancellable: false)
                    if current.map(Self.hash) == write.original.map(Self.hash) { continue }
                    guard current.map(Self.hash) == Self.hash(write.data) else { unsafe = true; continue }
                    let url = try Self.fileURL(root: root, path: write.path, mustExist: true)
                    if let original = write.original { try Self.replace(root: root, path: write.path, data: original, expected: Self.hash(write.data), cancellable: false) }
                    else { try FileManager.default.removeItem(at: url) }
                } catch { unsafe = true }
            }
            journal.phase = unsafe ? "recovery-required" : "rolled-back"; journal.recoveryRequired = unsafe
            do { try saveJournal() } catch { unsafe = true }
            if unsafe { throw BoardMergeError.recovery(backupPath + "/journal.json") }
            throw error
        }
    }

    private func verify(_ plan: Prepared, root: URL) throws {
        for file in plan.reads {
            try Task.checkCancellation()
            guard try Self.read(root: root, path: file.path, limit: Self.maximumBoardBytes, optional: file.data == nil).map(Self.hash) == file.hash else { throw BoardMergeError.changed }
        }
        for inventory in plan.inventories {
            guard try Self.names(root: root, path: inventory.path) == inventory.names else { throw BoardMergeError.changed }
        }
    }

    private func verifyBeforeMain(_ plan: Prepared, root: URL) throws {
        let sidecars = plan.writes.filter { $0.path != plan.preview.outputPath }
        let replaced = Set(sidecars.map(\.path))
        for file in plan.reads where !replaced.contains(file.path) {
            guard try Self.read(root: root, path: file.path, limit: Self.maximumBoardBytes, optional: file.data == nil).map(Self.hash) == file.hash else { throw BoardMergeError.changed }
        }
        for file in sidecars {
            guard try Self.read(root: root, path: file.path, limit: Self.maximumBoardBytes).map(Self.hash) == Self.hash(file.data) else { throw BoardMergeError.changed }
        }
        for inventory in plan.inventories {
            let added = sidecars.filter { ($0.path as NSString).deletingLastPathComponent == inventory.path }
                .map { ($0.path as NSString).lastPathComponent }
            guard Set(try Self.names(root: root, path: inventory.path)) == Set(inventory.names).union(added) else { throw BoardMergeError.changed }
        }
        for path in plan.references { _ = try Self.fileURL(root: root, path: path, mustExist: true) }
    }

    private static func bounds(_ input: Input) throws -> CGRect {
        var result = input.drawing.bounds
        if input.drawing.strokes.isEmpty { result = .null }
        for item in input.board.items {
            result = result.union(item.rect)
            for child in item.childBoards ?? [] { if let value = child.presentation { result = result.union(value.rect) } }
        }
        for pin in input.board.pins { result = result.union(CGRect(x: pin.x, y: pin.y, width: 0.01, height: 0.01)) }
        for frame in input.board.printFrames ?? [] { result = result.union(frame.rect) }
        for tape in input.tapes?.tapes ?? [] { for point in tape.points {
            result = result.union(CGRect(x: point.x - tape.width / 2, y: point.y - tape.width / 2, width: tape.width, height: tape.width))
        } }
        for (review, _, _) in input.reviews { result = result.union(review.rect.cgRect) }
        for stroke in try web(input) {
            guard let points = stroke["points"] as? [[Double]] else { throw BoardMergeError.invalid }
            for point in points {
                guard point.count >= 3, point.prefix(3).allSatisfy(\.isFinite), point[2] > 0 else { throw BoardMergeError.invalid }
                result = result.union(CGRect(x: point[0] - point[2] / 2, y: point[1] - point[2] / 2, width: point[2], height: point[2]))
            }
        }
        if !result.isNull, ![result.minX, result.minY, result.maxX, result.maxY].allSatisfy(\.isFinite) { throw BoardMergeError.invalid }
        return result
    }

    private static func web(_ input: Input) throws -> [[String: Any]] {
        if let web = input.json["webInk"] as? [String: Any] {
            guard (web["version"] as? Int) == 1, let strokes = web["strokes"] as? [[String: Any]] else { throw BoardMergeError.invalid }
            return try strokes.map { try translateWeb($0, dx: 0, dy: 0) }
        }
        // Preserve existing vectors exactly. Only a missing derived preview is
        // generated from the authoritative native ink, including ink-group data.
        var strokes = input.drawing.strokes
        for item in input.board.items where item.kind == .inkGroup {
            guard let bytes = item.inkData else { throw BoardMergeError.invalid }
            strokes += try PKDrawing(data: bytes).transformed(using: .init(translationX: item.x, y: item.y)).strokes
        }
        var output: [[String: Any]] = [], total = 0
        for stroke in strokes where !stroke.path.isEmpty {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1
#if canImport(UIKit)
            guard stroke.ink.color.getRed(&r, green: &g, blue: &b, alpha: &a) else { throw BoardMergeError.invalid }
#else
            guard let color = stroke.ink.color.usingColorSpace(.deviceRGB) else { throw BoardMergeError.invalid }
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
#endif
            let scale = sqrt(abs(stroke.transform.a * stroke.transform.d - stroke.transform.b * stroke.transform.c))
            let clip = try stroke.mask.map { mask -> [[Double]] in
                guard let commands = BoardWebClipPath.commands(from: mask.cgPath, transform: stroke.transform) else { throw BoardMergeError.tooLarge }; return commands
            }
            var points: [[Double]] = [], opacity: CGFloat = 0
            for point in stroke.path.interpolatedPoints(by: .distance(2)) {
                let location = point.location.applying(stroke.transform)
                points.append([location.x, location.y, (point.size.width + point.size.height) / 2 * scale]); opacity += point.opacity
                total += 1; guard total <= 1_000_000, points.count <= 50_000 else { throw BoardMergeError.tooLarge }
            }
            guard !points.isEmpty else { continue }
            var raw: [String: Any] = ["points": points, "color": String(format: "#%02X%02X%02X", Int(min(1, max(0, r)) * 255), Int(min(1, max(0, g)) * 255), Int(min(1, max(0, b)) * 255)),
                "opacity": Double(min(1, max(0, a * opacity / CGFloat(points.count)))), "startedAt": stroke.path.creationDate.timeIntervalSince1970]
            if let clip { raw["clipPath"] = clip }; output.append(raw)
            guard output.count <= 50_000 else { throw BoardMergeError.tooLarge }
        }
        return output
    }

    private static func translateWeb(_ input: [String: Any], dx: Double, dy: Double) throws -> [String: Any] {
        var value = input
        guard var points = value["points"] as? [[Double]], points.count <= 50_000,
              let color = value["color"] as? String, color.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil,
              let opacity = value["opacity"] as? Double, opacity.isFinite, (0...1).contains(opacity) else { throw BoardMergeError.invalid }
        for i in points.indices {
            guard points[i].count >= 3, points[i].allSatisfy(\.isFinite), points[i][2] > 0, points[i][2] <= 10_000 else { throw BoardMergeError.invalid }
            points[i][0] += dx; points[i][1] += dy
            guard abs(points[i][0]) <= 8_000_000, abs(points[i][1]) <= 8_000_000 else { throw BoardMergeError.noSpace }
        }
        value["points"] = points
        if var commands = value["clipPath"] as? [[Double]] {
            guard commands.count <= 10_000 else { throw BoardMergeError.tooLarge }
            for index in commands.indices {
                guard let kind = commands[index].first, let count = [0.0: 3, 1: 3, 2: 5, 3: 7, 4: 1][kind], commands[index].count == count,
                      commands[index].allSatisfy(\.isFinite) else { throw BoardMergeError.invalid }
                if count > 1 { for position in stride(from: 1, to: count, by: 2) { commands[index][position] += dx; commands[index][position + 1] += dy } }
            }
            value["clipPath"] = commands
        }
        return value
    }

    private static func annotations(_ a: [PDFAnnotationSource], _ b: [PDFAnnotationSource]) throws -> [[String: Any]] {
        var values: [String: (String, Set<Int>)] = [:]
        for value in a + b {
            let sha = value.sha256.lowercased()
            guard VaultPath.isSafeRelative(value.sourcePath), sha.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  value.pages.allSatisfy({ (1...100_000).contains($0) }) else { throw BoardMergeError.invalid }
            if let previous = values[value.sourcePath], previous.0 != sha { throw BoardMergeError.pdfConflict }
            values[value.sourcePath] = (sha, (values[value.sourcePath]?.1 ?? []).union(value.pages))
        }
        return values.keys.sorted().map { ["sourcePath": $0, "sha256": values[$0]!.0, "pages": values[$0]!.1.sorted()] }
    }

    private static func translate(_ object: inout [String: Any], dx: Double, dy: Double) throws {
        guard let x = object["x"] as? Double, let y = object["y"] as? Double, x.isFinite, y.isFinite else { throw BoardMergeError.invalid }
        object["x"] = x + dx; object["y"] = y + dy
    }
    private static func tapePath(_ id: UUID) -> String { ".inkspace/writing-aids/" + id.uuidString.lowercased() + ".json" }
    private static func preflightMemory(root: URL, sourcePath: String, targetPath: String) throws {
        func size(_ path: String) throws -> UInt64 {
            let url = try fileURL(root: root, path: path, mustExist: true)
            var info = stat()
            guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0,
                  info.st_size <= maximumBoardBytes else { throw BoardMergeError.tooLarge }
            return UInt64(info.st_size)
        }
        let source = try size(sourcePath), target = try size(targetPath)
        _ = try requiredMemoryHeadroom(sourceBytes: source, targetBytes: target)
#if os(iOS)
        try checkMemory(sourceBytes: source, targetBytes: target, availableBytes: UInt64(os_proc_available_memory()))
#endif
    }
    private static func rejectUnfinished(root: URL, sourcePath: String, targetPath: String) throws {
        let directory = ".inkspace/merge-history"
        let entries = try names(root: root, path: directory)
        guard entries.count <= 2_000 else { throw BoardMergeError.tooLarge }
        for name in entries {
            guard UUID(uuidString: name) != nil else { throw BoardMergeError.sidecar }
            let path = directory + "/" + name + "/journal.json"
            guard let data = try read(root: root, path: path, limit: 16 * 1024 * 1024, optional: true) else { continue }
            let value = try object(data)
            let paths: [String] = ["sourcePath", "targetPath", "outputPath"].compactMap { value[$0] as? String }
            let touches = paths.contains(where: { $0 == sourcePath || $0 == targetPath })
            if touches, ["publishing", "recovery-required", "undoing", "undo-recovery-required"].contains(value["phase"] as? String ?? "") {
                throw BoardMergeError.recovery(path)
            }
        }
    }
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private static func object(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw BoardMergeError.invalid }; return object
    }
    private static func json(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) }
    private static func directory(_ url: URL) throws {
        var stat = stat()
        guard lstat(url.path, &stat) == 0, stat.st_mode & S_IFMT == S_IFDIR,
              url.standardizedFileURL.path == url.resolvingSymlinksInPath().path else { throw BoardMergeError.unavailable }
    }
    private static func fileURL(root: URL, path: String, mustExist: Bool) throws -> URL {
        guard VaultPath.isSafeRelative(path) else { throw BoardMergeError.invalid }
        try directory(root)
        var url = root
        let parts = path.split(separator: "/")
        for (index, part) in parts.enumerated() {
            url.appendPathComponent(String(part))
            var info = stat()
            if lstat(url.path, &info) == 0 {
                guard info.st_mode & S_IFMT == (index == parts.count - 1 ? S_IFREG : S_IFDIR) else { throw BoardMergeError.unavailable }
            } else {
                guard errno == ENOENT, !mustExist else { throw BoardMergeError.unavailable }
            }
        }
        return url
    }
    private static func read(root: URL, path: String, limit: Int, optional: Bool = false, cancellable: Bool = true) throws -> Data? {
        let url = try fileURL(root: root, path: path, mustExist: !optional)
        var before = stat()
        if lstat(url.path, &before) != 0 {
            guard optional, errno == ENOENT else { throw BoardMergeError.unavailable }; return nil
        }
        guard before.st_mode & S_IFMT == S_IFREG, before.st_size >= 0, before.st_size <= limit else { throw BoardMergeError.tooLarge }
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw BoardMergeError.unavailable }; defer { close(fd) }
        var descriptor = stat(); guard fstat(fd, &descriptor) == 0, descriptor.st_ino == before.st_ino, descriptor.st_dev == before.st_dev else { throw BoardMergeError.changed }
        var data = Data(count: Int(before.st_size))
        try data.withUnsafeMutableBytes { raw in
            var offset = 0
            while offset < raw.count {
                if cancellable { try Task.checkCancellation() }
                let count = Darwin.read(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard count > 0 else { throw BoardMergeError.changed }; offset += count
            }
        }
        var after = stat(), named = stat()
        guard fstat(fd, &after) == 0, lstat(url.path, &named) == 0, named.st_ino == after.st_ino, named.st_dev == after.st_dev,
              before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw BoardMergeError.changed }
        return data
    }
    private static func names(root: URL, path: String) throws -> [String] {
        guard VaultPath.isSafeRelative(path) else { throw BoardMergeError.invalid }
        var url = root
        for part in path.split(separator: "/") {
            url.appendPathComponent(String(part)); var info = stat()
            if lstat(url.path, &info) != 0 { guard errno == ENOENT else { throw BoardMergeError.unavailable }; return [] }
            try directory(url)
        }
        return try FileManager.default.contentsOfDirectory(atPath: url.path).sorted()
    }
    private static func makeDirectory(root: URL, path: String) throws -> URL {
        guard VaultPath.isSafeRelative(path) else { throw BoardMergeError.invalid }
        try directory(root); var url = root
        for part in path.split(separator: "/") {
            url.appendPathComponent(String(part)); var info = stat()
            if lstat(url.path, &info) != 0 {
                guard errno == ENOENT else { throw BoardMergeError.unavailable }
                do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
                catch { try directory(url) }
            }
            try directory(url)
        }
        return url
    }
    private static func writeNew(_ data: Data, to url: URL) throws {
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".merge-" + UUID().uuidString.lowercased())
        defer { try? FileManager.default.removeItem(at: temporary) }
        try data.write(to: temporary, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        let fd = open(temporary.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw BoardMergeError.unavailable }; defer { close(fd) }
        guard fsync(fd) == 0, renamex_np(temporary.path, url.path, UInt32(RENAME_EXCL)) == 0 else { throw BoardMergeError.changed }
        guard hash(try Data(contentsOf: url)) == hash(data) else { throw BoardMergeError.changed }
    }
    private static func replace(root: URL, path: String, data: Data, expected: String?, cancellable: Bool = true) throws {
        let parent = (path as NSString).deletingLastPathComponent
        if !parent.isEmpty { _ = try makeDirectory(root: root, path: parent) }
        let url = try fileURL(root: root, path: path, mustExist: expected != nil)
        guard try read(root: root, path: path, limit: maximumBoardBytes, optional: true, cancellable: cancellable).map(hash) == expected else { throw BoardMergeError.changed }
        if expected == nil { try writeNew(data, to: url) }
        else {
            try data.write(to: url, options: .atomic)
            guard try read(root: root, path: path, limit: maximumBoardBytes, cancellable: cancellable).map(hash) == hash(data) else { throw BoardMergeError.changed }
        }
    }
}
