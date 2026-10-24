import Foundation
import PDFKit

/// Applies only to disposable in-memory PDFs or explicitly restored copies.
/// Identity recognition remains the same single-owner contract as writeback.
enum BoardPDFAnnotationOwners {
    static func cacheKey(_ owners: Set<UUID>) -> String {
        owners.map { $0.uuidString.lowercased() }.sorted().joined(separator: ",")
    }
    static func isOwned(_ annotation: PDFAnnotation, owners: Set<UUID>) -> Bool {
        owners.contains { PDFAnnotationWritebackService.isOwnedAnnotation(annotation, boardID: $0) }
    }
    static func hide(in page: PDFPage, owners: Set<UUID>) {
        guard !owners.isEmpty else { return }
        for annotation in page.annotations where isOwned(annotation, owners: owners) { page.removeAnnotation(annotation) }
    }
}
