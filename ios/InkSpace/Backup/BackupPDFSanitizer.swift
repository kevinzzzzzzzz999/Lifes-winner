import Foundation
import PDFKit

/// Restore modifies only newly created copies. The proven incremental writer
/// preserves the original byte prefix and foreign objects; no PDFKit reserialization
/// fallback is allowed here. Unsupported protected structures fail closed.
enum BackupPDFSanitizer {
    static func removingOwnedInk(_ bytes: Data, boardIDs: Set<UUID>) throws -> Data {
        guard boardIDs.count <= 129 else { throw BoardBackupError.corrupt }
        var output = bytes
        // Each existing incremental operation verifies other annotations stay
        // intact. The restored copy is independent; original PDFs are untouched.
        for boardID in boardIDs.sorted(by: { $0.uuidString < $1.uuidString }) {
            output = try removingOwnedInk(output, boardID: boardID)
        }
        return output
    }
    static func removingOwnedInk(_ bytes: Data, boardID: UUID) throws -> Data {
        guard bytes.count <= 256 * 1024 * 1024, let pdf = PDFDocument(data: bytes), !pdf.isLocked else { throw BoardBackupError.unsupportedPDF }
        var affected = Set<Int>()
        for index in 0..<pdf.pageCount {
            try Task.checkCancellation()
            guard let page = pdf.page(at: index) else { throw BoardBackupError.unsupportedPDF }
            if page.annotations.contains(where: { PDFAnnotationWritebackService.isOwnedAnnotation($0, boardID: boardID) }) { affected.insert(index) }
        }
        guard !affected.isEmpty else { return bytes }
        let foreign = snapshots(pdf, owner: boardID)
        let output: Data
        do { output = try PDFIncrementalInkWriter.update(original: bytes, pdf: pdf, boardID: boardID, projected: [:], affectedPages: affected) }
        catch is CancellationError { throw CancellationError() }
        catch { throw BoardBackupError.unsupportedPDF }
        guard output.starts(with: bytes), let restored = PDFDocument(data: output), restored.pageCount == pdf.pageCount,
              snapshots(restored, owner: boardID) == foreign else { throw BoardBackupError.corrupt }
        for index in 0..<restored.pageCount {
            guard let page = restored.page(at: index), !page.annotations.contains(where: {
                PDFAnnotationWritebackService.isOwnedAnnotation($0, boardID: boardID)
            }) else { throw BoardBackupError.corrupt }
        }
        return output
    }
    private static func snapshots(_ pdf: PDFDocument, owner: UUID) -> [[String]] {
        (0..<pdf.pageCount).map { index in
            (pdf.page(at: index)?.annotations ?? []).filter { !PDFAnnotationWritebackService.isOwnedAnnotation($0, boardID: owner) }.map { annotation in
                // Foreign annotation objects/AP are byte-preserved by the writer;
                // additionally compare their reachable public identity and geometry.
                [annotation.type ?? "", annotation.contents ?? "", annotation.userName ?? "",
                 String(describing: annotation.value(forAnnotationKey: .name)), NSCoder.string(for: annotation.bounds),
                 String(annotation.shouldDisplay), String(annotation.shouldPrint)].joined(separator: "\u{0}")
            }
        }
    }
}
