import Foundation

/// Uses the existing v1 rectangular highlight protocol. No PDF annotation or
/// document writer is involved; each selected line is a normal sidecar mark.
enum PDFReadingHighlight {
    static let layerName = "Reading Highlights"
    static let maximumParts = 256
    struct Part {
        let page: Int
        let rect: PDFWorkspaceRect
        let text: String
    }
    static func allows(_ kind: PDFWorkspaceAnnotation.Kind) -> Bool { kind == .highlight }
    static func make(parts: [Part], layerID: UUID, sourceSHA256: String, note: String = "") throws -> [PDFWorkspaceAnnotation] {
        guard !parts.isEmpty, parts.count <= maximumParts, note.unicodeScalars.count <= 4000 else { throw PDFWorkspaceError.tooLarge }
        return try parts.enumerated().map { index, part in
            let text = part.text + (index == 0 && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "\n\n" + note : "")
            let mark = PDFWorkspaceAnnotation(id: UUID(), layerID: layerID, sourceSHA256: sourceSHA256, page: part.page,
                kind: .highlight, color: "#F2C94C", width: 0.003, points: [], rect: part.rect, text: text)
            // Reuse exactly the cross-platform schema validator, including bounds.
            return try PDFWorkspaceEvent.decodeValidated(PDFWorkspaceEvent.make(annotation: mark).encoded()).annotation!
        }
    }
}
