import Foundation
import PencilKit

/// A flat polygon fill cannot be represented by a PDF Ink annotation. Keep
/// these pages on the companion's existing filtered-PDF + full-board-ink path
/// instead of claiming the source PDF contains every visible native stroke.
enum BoardPDFInkCoverage {
    static func boardOnlyPages(strokes: [PKStroke], items: [BoardItem]) -> [String: Set<Int>] {
        let fillBounds = strokes.filter(BoardWritingAidStrokes.isTaggedFill).map(\.renderBounds)
        guard !fillBounds.isEmpty else { return [:] }
        var result: [String: Set<Int>] = [:]
        for item in items where item.kind == .pdfPage {
            guard let source = item.sourcePath, !source.isEmpty,
                  let page = item.page, page > 0,
                  [item.x, item.y, item.width, item.height].allSatisfy(\.isFinite),
                  item.width > 0, item.height > 0,
                  fillBounds.contains(where: { $0.intersects(item.rect) }) else { continue }
            result[source, default: []].insert(page)
        }
        return result
    }

    static func sourcePages(_ pages: [Int], excluding boardOnlyPages: Set<Int>?) -> [Int] {
        guard let boardOnlyPages, !boardOnlyPages.isEmpty else { return pages }
        return pages.filter { !boardOnlyPages.contains($0) }
    }
}
