import Foundation
import CryptoKit
import PDFKit
import PencilKit

struct PDFWritebackFailure: Sendable {
    let sourcePath: String
    let message: String
    var errorDomain: String? = nil
    var errorCode: Int? = nil
}

struct PDFWritebackReport: Sendable {
    var changedPaths: Set<String> = []
    var successfulPaths: Set<String> = []
    var backupPaths: Set<String> = []
    var sourceDigests: [String: String] = [:]
    var failures: [PDFWritebackFailure] = []
}

enum PDFWritebackError: LocalizedError {
    case invalidPath, invalidDrawing, unreadablePDF, protectedPDF, signedPDF, invalidPage(Int)
    case invalidGeometry, tooComplex, unavailable, externalChange, serializationFailed, foreignAnnotationsChanged
    var errorDescription: String? {
        switch self {
        case .invalidPath: String(localized: "PDF 路径不在已授权仓库内，或原文件不可用。")
        case .invalidDrawing: String(localized: "无法读取白板笔迹；原 PDF 保持不变。")
        case .unreadablePDF: String(localized: "无法完整读取 PDF；原文件保持不变。")
        case .protectedPDF: String(localized: "PDF 已加密、只读或不允许添加注释；原文件保持不变。")
        case .signedPDF: String(localized: "PDF 含数字签名字段，未写回，以保留签名文件。")
        case .invalidPage(let number): String(localized: "原 PDF 中没有第 \(number) 页，未写回这个文件。")
        case .invalidGeometry: String(localized: "PDF 页面或白板笔迹的坐标无效，未写回这个文件。")
        case .tooComplex: String(localized: "这次 PDF 笔迹量过大，未写回；白板笔迹仍保留。")
        case .unavailable: String(localized: "PDF 暂时不可写，请检查文件夹授权及 iCloud 下载状态。")
        case .externalChange: String(localized: "写回期间原 PDF 再次发生变化，已停止覆盖，请重试。")
        case .serializationFailed: String(localized: "PDF 注释无法安全保存，原文件保持不变。")
        case .foreignAnnotationsChanged: String(localized: "系统无法完整保留原 PDF 的其他注释或注释标识，已停止写回；原文件和白板笔迹保持不变。")
        }
    }
}

/// The input drawing is already in world coordinates, including any ink-group
/// translations. This service deliberately does not also decode item.inkData.
/// A PDF page image must fill its item's entire rectangle, without title padding.
@MainActor
final class PDFAnnotationWritebackService {
    private static let worker = DispatchQueue(label: "InkSpace.pdf-annotation-writeback", qos: .utility)

    func synchronize(rootURL: URL, boardID: UUID, items: [BoardItem], drawingData: Data,
                     previousSourcePaths: Set<String> = [],
                     createBackupIfMissing: Bool = true) async -> PDFWritebackReport {
        let pages = items.filter { $0.kind == .pdfPage }.compactMap(PDFInkPagePlacement.init)
        let invalidPages = items.filter { $0.kind == .pdfPage && PDFInkPagePlacement($0) == nil }
        let invalidPaths = Set(invalidPages.compactMap(\.sourcePath))
        let sources = Set(pages.map(\.sourcePath)).union(previousSourcePaths).union(invalidPaths)
        let lease = PDFWritebackScope(rootURL)
        return await withCheckedContinuation { continuation in
            Self.worker.async {
                let result = autoreleasepool {
                    Self.perform(root: rootURL, boardID: boardID, pages: pages,
                                 invalidPaths: invalidPaths, sourcePaths: sources,
                                 drawingData: drawingData, backup: createBackupIfMissing, lease: lease)
                }
                continuation.resume(returning: result)
            }
        }
    }

    nonisolated static func ownerPrefix(boardID: UUID) -> String {
        "InkSpace.v1.\(boardID.uuidString)."
    }

    nonisolated static func isOwnedAnnotation(_ annotation: PDFAnnotation, boardID: UUID) -> Bool {
        guard let name = annotationIdentifier(annotation) else { return false }
        return name.hasPrefix(ownerPrefix(boardID: boardID))
    }

    // Some PDFKit versions discard a newly assigned /NM when writing. /Contents
    // is a standard, interoperable field that survives that round trip, so retain
    // the same strict identity there as a fallback instead of leaving orphan ink.
    nonisolated static func annotationContents(identifier: String) -> String {
        "InkSpace 手写\n[InkSpace annotation: \(identifier)]"
    }

    nonisolated static func annotationIdentifier(_ annotation: PDFAnnotation) -> String? {
        if let name = annotation.value(forAnnotationKey: .name) as? String,
           name.hasPrefix("InkSpace.v1.") { return name }
        let prefix = "InkSpace 手写\n[InkSpace annotation: "
        guard let contents = annotation.contents, contents.hasPrefix(prefix), contents.hasSuffix("]") else { return nil }
        let identifier = String(contents.dropFirst(prefix.count).dropLast())
        return identifier.hasPrefix("InkSpace.v1.") ? identifier : nil
    }

    /// Only call on a private PDFDocument used for this board's display. Never save
    /// that filtered document back to disk; write-back always opens a fresh original.
    nonisolated static func removeOwnedAnnotations(from document: PDFDocument, boardID: UUID) {
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            for annotation in page.annotations where isOwnedAnnotation(annotation, boardID: boardID) {
                page.removeAnnotation(annotation)
            }
        }
    }

    private nonisolated static func perform(root: URL, boardID: UUID, pages: [PDFInkPagePlacement],
                                           invalidPaths: Set<String>, sourcePaths: Set<String>,
                                           drawingData: Data, backup: Bool,
                                           lease: PDFWritebackScope) -> PDFWritebackReport {
        _ = lease // Retain the original security-scoped URL until all coordination finishes.
        var report = PDFWritebackReport()
        let drawing: PKDrawing
        do { drawing = try PKDrawing(data: drawingData) }
        catch {
            report.failures = sourcePaths.sorted().map {
                PDFWritebackFailure(sourcePath: $0, message: PDFWritebackError.invalidDrawing.localizedDescription,
                                    errorDomain: (error as NSError).domain, errorCode: (error as NSError).code)
            }
            return report
        }
        for sourcePath in sourcePaths.sorted() {
            do {
                guard !invalidPaths.contains(sourcePath) else { throw PDFWritebackError.invalidGeometry }
                let result = try updateFile(root: root, sourcePath: sourcePath, boardID: boardID,
                                            placements: pages.filter { $0.sourcePath == sourcePath },
                                            drawing: drawing, backup: backup)
                report.successfulPaths.insert(sourcePath)
                report.sourceDigests[sourcePath] = result.digest
                if result.changed { report.changedPaths.insert(sourcePath) }
                if let path = result.backupPath { report.backupPaths.insert(path) }
            } catch {
                report.failures.append(PDFWritebackFailure(sourcePath: sourcePath, message: error.localizedDescription,
                    errorDomain: (error as NSError).domain, errorCode: (error as NSError).code))
            }
        }
        return report
    }

    private nonisolated static func updateFile(root: URL, sourcePath: String, boardID: UUID,
                                              placements: [PDFInkPagePlacement], drawing: PKDrawing,
                                              backup: Bool) throws -> (changed: Bool, backupPath: String?, digest: String) {
        guard sourcePath.lowercased().hasSuffix(".pdf"),
              let originalURL = VaultPathResolver.resolve(relativePath: sourcePath, within: root) else {
            throw PDFWritebackError.invalidPath
        }
        var coordinationError: NSError?
        var outcome: Result<(Bool, String?, String), Error> = .failure(PDFWritebackError.unavailable)
        NSFileCoordinator().coordinate(writingItemAt: originalURL, options: .forReplacing,
                                       error: &coordinationError) { target in
            outcome = Result {
                guard let verified = VaultPathResolver.resolve(relativePath: sourcePath, within: root),
                      verified.standardizedFileURL.resolvingSymlinksInPath() == target.standardizedFileURL.resolvingSymlinksInPath()
                else { throw PDFWritebackError.invalidPath }
                let manager = FileManager.default
                guard manager.isWritableFile(atPath: target.path) else { throw PDFWritebackError.protectedPDF }
                let original = try Data(contentsOf: target, options: .mappedIfSafe)
                let originalHash = SHA256.hash(data: original)
                guard let pdf = PDFDocument(data: original), pdf.pageCount > 0 else {
                    throw PDFWritebackError.unreadablePDF
                }
                // Re-saving an encrypted or signed PDF can silently change its
                // protection/signature. Those sources require a separate unlocked copy.
                guard !pdf.isEncrypted, !pdf.isLocked, pdf.allowsCommenting else {
                    throw PDFWritebackError.protectedPDF
                }
                for index in 0..<pdf.pageCount {
                    guard let page = pdf.page(at: index) else { throw PDFWritebackError.unreadablePDF }
                    if page.annotations.contains(where: {
                        let field = $0.value(forAnnotationKey: .widgetFieldType) as? String
                        return field == "Sig" || field == "/Sig"
                    }) { throw PDFWritebackError.signedPDF }
                }
                // Validate/project the entire source before removing any annotations.
                let projected = try PDFInkProjection.project(drawing, placements: placements, in: pdf, boardID: boardID)
                var existing: [Int: [PDFAnnotation]] = [:]
                for index in 0..<pdf.pageCount {
                    existing[index] = pdf.page(at: index)!.annotations.filter { isOwnedAnnotation($0, boardID: boardID) }
                }
                let pageIndexes = Set(existing.filter { !$0.value.isEmpty }.keys).union(projected.keys)
                let matches = pageIndexes.allSatisfy {
                    PDFInkProjection.matches(existing[$0] ?? [], specifications: projected[$0] ?? [])
                }
                guard !matches else { return (false, nil, originalHash.map { String(format: "%02x", $0) }.joined()) }
                // Snapshot values, not PDFAnnotation references: PDFKit may mutate
                // its in-memory objects while serializing. In particular, some
                // system versions discard even an existing third-party /NM.
                let foreignBefore = foreignAnnotations(in: pdf, excluding: boardID)
                let output: Data
                do {
                    // Preserve the original byte sequence and foreign PDF objects.
                    // Supported sources only append changes to this board's Ink.
                    output = try PDFIncrementalInkWriter.update(original: original, pdf: pdf,
                        boardID: boardID, projected: projected, affectedPages: pageIndexes)
                } catch PDFIncrementalWriteError.unsupportedFormat {
                    // Retain the existing path for unsupported PDF structures;
                    // its post-write integrity checks remain mandatory below.
                    for index in pageIndexes {
                        let page = pdf.page(at: index)!
                        for annotation in existing[index] ?? [] { page.removeAnnotation(annotation) }
                        for spec in projected[index] ?? [] { page.addAnnotation(spec.makeAnnotation()) }
                    }
                    guard let bytes = pdf.dataRepresentation() else { throw PDFWritebackError.serializationFailed }
                    output = bytes
                } catch PDFIncrementalWriteError.protectedDocument {
                    throw PDFWritebackError.signedPDF
                } catch PDFIncrementalWriteError.tooComplex {
                    throw PDFWritebackError.tooComplex
                } catch {
                    // A malformed or ambiguous object graph is not a request to
                    // bypass the incremental writer through a lossy serializer.
                    throw PDFWritebackError.serializationFailed
                }
                guard let checked = PDFDocument(data: output), checked.pageCount == pdf.pageCount,
                      pageIndexes.allSatisfy({
                          guard let page = checked.page(at: $0) else { return false }
                          return PDFInkProjection.matches(page.annotations.filter { isOwnedAnnotation($0, boardID: boardID) },
                                                          specifications: projected[$0] ?? [])
                      }) else { throw PDFWritebackError.serializationFailed }
                guard foreignBefore == foreignAnnotations(in: checked, excluding: boardID) else {
                    throw PDFWritebackError.foreignAnnotationsChanged
                }
                // The coordinator excludes cooperating writers; this second digest
                // also catches non-cooperating changes during PDFKit serialization.
                guard SHA256.hash(data: try Data(contentsOf: target, options: .mappedIfSafe)) == originalHash else {
                    throw PDFWritebackError.externalChange
                }
                var backupPath: String?
                if backup { backupPath = try makeBackupIfMissing(original, root: root, sourcePath: sourcePath) }
                // Atomic replacement keeps the old original intact on a failed write.
                // iCloud transport/cross-device reconciliation is not a transaction.
                try output.write(to: target, options: .atomic)
                return (true, backupPath, SHA256.hash(data: output).map { String(format: "%02x", $0) }.joined())
            }
        }
        if let coordinationError { throw coordinationError }
        return try outcome.get()
    }

    private nonisolated static func foreignAnnotations(in pdf: PDFDocument, excluding boardID: UUID)
        -> [[PDFForeignAnnotationSnapshot]] {
        (0..<pdf.pageCount).map { index in
            pdf.page(at: index)!.annotations
                .filter { !isOwnedAnnotation($0, boardID: boardID) }
                .map(PDFForeignAnnotationSnapshot.init)
        }
    }

    private nonisolated static func makeBackupIfMissing(_ original: Data, root: URL, sourcePath: String) throws -> String? {
        let root = root.standardizedFileURL.resolvingSymlinksInPath()
        let digest = SHA256.hash(data: Data(sourcePath.utf8)).map { String(format: "%02x", $0) }.joined()
        let relative = ".inkspace-pdf-backups/\(digest).pdf"
        let target = root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard target.pathComponents.count > root.pathComponents.count,
              Array(target.pathComponents.prefix(root.pathComponents.count)) == root.pathComponents else {
            throw PDFWritebackError.invalidPath
        }
        if FileManager.default.fileExists(atPath: target.path) { return nil }
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try original.write(to: target, options: .atomic)
        return relative
    }
}

/// Public PDFKit fields that must survive rewriting untouched annotations. This
/// does not claim to validate every vendor-specific PDF dictionary extension.
private struct PDFForeignAnnotationSnapshot: Equatable {
    let type: String?
    let bounds: CGRect
    let name: String?
    let contents: String?
    let userName: String?
    let shouldDisplay: Bool
    let shouldPrint: Bool
    let color: [CGFloat]
    let borderWidth: CGFloat?
    let paths: [[CGFloat]]

    init(_ annotation: PDFAnnotation) {
        type = annotation.type; bounds = annotation.bounds
        name = annotation.value(forAnnotationKey: .name) as? String
        contents = annotation.contents; userName = annotation.userName
        shouldDisplay = annotation.shouldDisplay; shouldPrint = annotation.shouldPrint
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        if annotation.color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) {
            color = [red, green, blue, alpha]
        } else { color = annotation.color.cgColor.components ?? [] }
        borderWidth = annotation.border?.lineWidth
        paths = (annotation.paths ?? []).map { path in
            var values: [CGFloat] = []
            path.cgPath.applyWithBlock { pointer in
                let element = pointer.pointee
                values.append(CGFloat(element.type.rawValue))
                let count: Int
                switch element.type {
                case .moveToPoint, .addLineToPoint: count = 1
                case .addQuadCurveToPoint: count = 2
                case .addCurveToPoint: count = 3
                case .closeSubpath: count = 0
                @unknown default: count = 0
                }
                for index in 0..<count {
                    values.append(element.points[index].x)
                    values.append(element.points[index].y)
                }
            }
            return values
        }
    }
}

private final class PDFWritebackScope: @unchecked Sendable {
    let url: URL
    let acquired: Bool
    init(_ url: URL) { self.url = url; acquired = url.startAccessingSecurityScopedResource() }
    deinit { if acquired { url.stopAccessingSecurityScopedResource() } }
}
