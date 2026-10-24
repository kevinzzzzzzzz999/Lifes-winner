import Foundation
import PDFKit

/// Called off the main actor. Keeps the source page order and rotation, and never
/// overwrites an existing vault file. Shared by the scanner and synthetic checks.
enum ScannedPDFExport {
    static func save(pages: [PDFPage], root: URL, relativeDirectory: String, title: String) throws -> URL {
        guard !pages.isEmpty else { throw ScanSaveError.invalidPDF }
        let document = PDFDocument()
        for page in pages { document.insert(page, at: document.pageCount) }
        guard let data = document.dataRepresentation(),
              PDFDocument(data: data)?.pageCount == pages.count else { throw ScanSaveError.invalidPDF }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpace-Scan-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let temporaryPDF = temporary.appendingPathComponent("Scan.pdf")
        try data.write(to: temporaryPDF, options: .atomic)
        let access = root.startAccessingSecurityScopedResource()
        defer { if access { root.stopAccessingSecurityScopedResource() } }
        let folder = try BoardStorageLocations.directory(root: root, relativePath: relativeDirectory)
        var name = title.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_").replacingOccurrences(of: ":", with: "_")
        name = String(name.filter { !$0.isNewline && $0 != "\0" }.prefix(100))
        if name.lowercased().hasSuffix(".pdf") { name = String(name.dropLast(4)) }
        while name.utf8.count > 180 { name.removeLast() }
        if name.isEmpty || name.hasPrefix(".") { name = "Scan-" + String(UUID().uuidString.prefix(8)) }
        var target = folder.appendingPathComponent(name + ".pdf")
        var suffix = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent("\(name) (\(suffix)).pdf"); suffix += 1
        }
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var result: Result<Void, Error> = .failure(VaultWriteError.unavailable)
        coordinator.coordinate(writingItemAt: target, options: [], error: &coordinationError) { destination in
            result = Result {
                // copyItem fails if a concurrent writer created this name; never overwrite.
                try FileManager.default.copyItem(at: temporaryPDF, to: destination)
            }
        }
        if let coordinationError { throw coordinationError }
        try result.get()
        return target
    }
}

enum ScanSaveError: LocalizedError {
    case invalidPDF
    var errorDescription: String? { String(localized: "无法生成完整的多页 PDF") }
}
