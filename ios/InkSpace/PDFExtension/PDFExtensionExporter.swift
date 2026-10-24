import Foundation
import PDFKit
import CoreText
import ImageIO
#if canImport(UIKit)
import SwiftUI
import UIKit
#endif

struct PDFExtensionExportProgress {
    var completedPages: Int
    var totalPages: Int
    var sourcePage: Int
    var sourcePageCount: Int
}

enum PDFExtensionExportError: LocalizedError {
    case invalidPage, outputFailed, outputTooLarge
    var errorDescription: String? {
        switch self {
        case .invalidPage: String(localized: "部分 PDF 页面或留白无法导出，请刷新后重试。")
        case .outputFailed: String(localized: "导出副本未能完整写入，请检查可用空间后重试。")
        case .outputTooLarge: String(localized: "导出副本过大，请改为导出当前页。")
        }
    }
}

/// A private disk snapshot plus a streaming PDF context keeps memory independent
/// of book length. Source text stays vector-backed/selectable. All note modes
/// expand at their anchors; each source page starts a new output page and spills
/// into same-size continuation pages, preserving source order and crop/rotation.
@MainActor enum PDFExtensionExporter {
    private static let maximumOutputPages = 100_000
    private static let maximumOutputBytes = 1_024 * 1_024 * 1_024

    static func export(sourceSHA256: String, blocks: [PDFExtensionBlock], marks: [PDFWorkspaceAnnotation],
                       repository: PDFExtensionRepository, pages: ClosedRange<Int>? = nil,
                       progress: (PDFExtensionExportProgress) -> Void = { _ in }) async throws -> URL {
        try Task.checkCancellation()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpace-PDF-Notes-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        var success = false
        defer { if !success { try? FileManager.default.removeItem(at: directory) } }
        let snapshot = directory.appendingPathComponent("source.pdf")
        try await repository.copyPDFSnapshot(to: snapshot, expectedSHA256: sourceSHA256)
        guard let document = PDFDocument(url: snapshot), !document.isLocked, document.pageCount > 0 else { throw PDFWorkspaceError.unavailable }
        let range = pages ?? 1...document.pageCount
        guard range.lowerBound >= 1, range.upperBound <= document.pageCount,
              blocks.allSatisfy({ (1...document.pageCount).contains($0.page) }),
              marks.allSatisfy({ $0.sourceSHA256 == sourceSHA256 && (1...document.pageCount).contains($0.page) }) else { throw PDFExtensionExportError.invalidPage }
        let groupedBlocks = Dictionary(grouping: blocks, by: \.page)
        let groupedMarks = Dictionary(grouping: marks, by: \.page)
        var expectedSizes: [CGSize] = []
        for number in range {
            try Task.checkCancellation()
            guard let page = document.page(at: number - 1) else { throw PDFExtensionExportError.invalidPage }
            let plan = try layout(page: page, blocks: groupedBlocks[number] ?? [])
            guard expectedSizes.count + plan.count <= maximumOutputPages else { throw PDFExtensionExportError.outputTooLarge }
            expectedSizes.append(contentsOf: repeatElement(plan.display.size, count: plan.count))
            if number % 32 == 0 { await Task.yield() }
        }
        let stem = repository.sourceURL.deletingPathExtension().lastPathComponent
        let name = String(stem.prefix(80)) + (pages == nil ? "-含留白笔记.pdf" : "-第\(range.lowerBound)页-含留白笔记.pdf")
        let output = directory.appendingPathComponent(name)
        guard let consumer = CGDataConsumer(url: output as CFURL) else { throw PDFExtensionExportError.outputFailed }
        var firstBox = CGRect(origin: .zero, size: expectedSizes[0])
        guard let context = CGContext(consumer: consumer, mediaBox: &firstBox,
                                      [kCGPDFContextCreator: "人生赢家", kCGPDFContextTitle: stem] as CFDictionary) else { throw PDFExtensionExportError.outputFailed }
        var closed = false
        defer { if !closed { context.closePDF() } }
        var completed = 0
        for number in range {
            try Task.checkCancellation()
            guard let page = document.page(at: number - 1) else { throw PDFExtensionExportError.invalidPage }
            let pageBlocks = groupedBlocks[number] ?? [], pageMarks = groupedMarks[number] ?? []
            let plan = try layout(page: page, blocks: pageBlocks)
            let byID = Dictionary(uniqueKeysWithValues: pageBlocks.map { ($0.id, $0) })
            for continuation in 0..<plan.count {
                try Task.checkCancellation()
                progress(.init(completedPages: completed, totalPages: expectedSizes.count, sourcePage: number, sourcePageCount: document.pageCount))
                var box = CGRect(origin: .zero, size: plan.display.size)
                context.beginPDFPage([kCGPDFContextMediaBox: Data(bytes: &box, count: MemoryLayout<CGRect>.size)] as CFDictionary)
                context.saveGState()
                context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(box)
                context.translateBy(x: 0, y: box.height); context.scaleBy(x: 1, y: -1)
                context.clip(to: box)
                let offset = Double(continuation) * box.height
                context.translateBy(x: 0, y: -offset)
                for slice in plan.slices where slice.y * box.width < offset + box.height && (slice.y + slice.height) * box.width > offset {
                    try Task.checkCancellation()
                    context.saveGState()
                    context.translateBy(x: 0, y: slice.y * box.width)
                    context.clip(to: CGRect(x: 0, y: 0, width: box.width, height: slice.height * box.width))
                    switch slice.kind {
                    case let .original(start, _):
                        autoreleasepool {
                            context.saveGState()
                            context.translateBy(x: -plan.display.minX, y: plan.display.height * (1 - start) + plan.display.minY)
                            context.scaleBy(x: 1, y: -1)
                            page.draw(with: .cropBox, to: context)
                            context.restoreGState()
                            context.saveGState(); context.translateBy(x: 0, y: -start * plan.display.height)
                            drawMarks(pageMarks, context: context, size: plan.display.size)
                            context.restoreGState()
                        }
                    case let .note(id):
                        guard let block = byID[id] else { throw PDFExtensionExportError.invalidPage }
                        try await drawNote(block, context: context, width: box.width, repository: repository)
                    }
                    context.restoreGState()
                }
                context.restoreGState(); context.endPDFPage()
                completed += 1
                try checkOutput(output)
                await Task.yield()
            }
        }
        context.closePDF(); closed = true
        try Task.checkCancellation()
        try checkOutput(output)
        guard let verified = PDFDocument(url: output), verified.pageCount == expectedSizes.count else { throw PDFExtensionExportError.outputFailed }
        for (index, size) in expectedSizes.enumerated() {
            try Task.checkCancellation()
            guard let page = verified.page(at: index), page.bounds(for: .mediaBox).size == size else { throw PDFExtensionExportError.outputFailed }
            if index % 32 == 0 { await Task.yield() }
        }
        // The exported copy already owns all drawn resources.
        try FileManager.default.removeItem(at: snapshot)
        progress(.init(completedPages: completed, totalPages: completed, sourcePage: range.upperBound, sourcePageCount: document.pageCount))
        success = true
        return output
    }

    static func removeTemporaryExport(_ url: URL) {
        let directory = url.deletingLastPathComponent()
        guard directory.lastPathComponent.hasPrefix("InkSpace-PDF-Notes-"),
              directory.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL else { return }
        try? FileManager.default.removeItem(at: directory)
    }

    private static func layout(page: PDFPage, blocks: [PDFExtensionBlock]) throws -> (display: CGRect, slices: [PDFExtensionSlice], count: Int) {
        let display = page.bounds(for: .cropBox).applying(page.transform(for: .cropBox)).standardized
        guard display.width.isFinite, display.height.isFinite, display.width > 0, display.height > 0,
              display.width <= 14_400, display.height <= 14_400, blocks.count <= 200,
              Set(blocks.map(\.id)).count == blocks.count else { throw PDFExtensionExportError.invalidPage }
        let slices = PDFExtensionGeometry.slices(pageAspect: display.height / display.width, blocks: blocks, expanded: Set(blocks.map(\.id)))
        let total = slices.reduce(0) { $0 + $1.height } * display.width
        guard total.isFinite, total > 0, total / display.height <= Double(maximumOutputPages) else { throw PDFExtensionExportError.outputTooLarge }
        return (display, slices, max(1, Int(ceil(total / display.height - 0.000000001))))
    }

    private static func checkOutput(_ url: URL) throws {
        guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= maximumOutputBytes else { throw PDFExtensionExportError.outputTooLarge }
    }

    private static func drawNote(_ block: PDFExtensionBlock, context: CGContext, width: CGFloat, repository: PDFExtensionRepository) async throws {
        let header = 0.10 * width
        context.setFillColor(CGColor(gray: 0.96, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: header))
        drawText(block.title.isEmpty ? String(localized: "留白笔记") : block.title,
                 in: CGRect(x: width * 0.0185, y: width * 0.0185, width: width * 0.963, height: header - width * 0.03),
                 size: width * 0.0296, color: CGColor(gray: 0, alpha: 1), context: context)
        context.translateBy(x: 0, y: header)
        drawText(block.text, in: CGRect(x: width * 0.025, y: width * 0.025, width: width * 0.95, height: block.height * width - width * 0.05),
                 size: width * 0.025, color: CGColor(gray: 0, alpha: 1), context: context)
        for image in block.images {
            try Task.checkCancellation()
            let data = try await repository.readAsset(image)
            try autoreleasepool {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 2048, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { throw PDFWorkspaceError.invalidRecord }
                let rect = CGRect(x: image.x * width, y: image.y * width, width: image.width * width, height: image.height * width)
                context.saveGState(); context.translateBy(x: rect.minX, y: rect.maxY); context.scaleBy(x: 1, y: -1)
                context.draw(cg, in: CGRect(origin: .zero, size: rect.size)); context.restoreGState()
            }
        }
        for stroke in block.strokes {
            try Task.checkCancellation()
            if PDFNativeInk.paint(stroke.nativeInk,width:width,context:context) {continue}
            drawStroke(stroke.points, width: stroke.width * width, color: color(stroke.color), size: CGSize(width: width, height: width), context: context)
        }
    }

    private static func drawMarks(_ marks: [PDFWorkspaceAnnotation], context: CGContext, size: CGSize) {
        for mark in marks {
            let rect = CGRect(x: mark.rect.x * size.width, y: mark.rect.y * size.height, width: mark.rect.width * size.width, height: mark.rect.height * size.height)
            let ink = color(mark.color)
            context.saveGState()
            switch mark.kind {
            case .ink:
                if !PDFNativeInk.paint(mark.nativeInk,width:size.width,context:context) {
                    drawStroke(mark.points, width: max(0.5, mark.width * size.width), color: ink, size: size, context: context)
                }
            case .highlight: context.setFillColor(ink.copy(alpha: 0.25)!); context.fill(rect)
            case .text:
                context.setFillColor(ink.copy(alpha: 0.1)!); context.fill(rect)
                drawText(mark.text, in: rect.insetBy(dx: 3, dy: 3), size: max(7, min(30, size.width * 0.025)), color: ink, context: context)
            }
            context.restoreGState()
        }
    }

    private static func drawStroke(_ points: [[Double]], width: CGFloat, color: CGColor, size: CGSize, context: CGContext) {
        context.setStrokeColor(color); context.setFillColor(color); context.setLineWidth(width); context.setLineCap(.round); context.setLineJoin(.round)
        let valid = points.filter { $0.count == 2 }
        if valid.count == 1, let p = valid.first { context.fillEllipse(in: CGRect(x: p[0] * size.width - width / 2, y: p[1] * size.height - width / 2, width: width, height: width)); return }
        context.beginPath()
        for (index, p) in valid.enumerated() { let point = CGPoint(x: p[0] * size.width, y: p[1] * size.height); if index == 0 { context.move(to: point) } else { context.addLine(to: point) } }
        context.strokePath()
    }

    private static func color(_ value: String) -> CGColor {
        let rgb = UInt64(value.dropFirst(), radix: 16) ?? 0
        return CGColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
    }

    private static func drawText(_ text: String, in rect: CGRect, size: CGFloat, color: CGColor, context: CGContext) {
        guard !text.isEmpty, rect.width > 0, rect.height > 0 else { return }
        let string = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, size, nil), NSAttributedString.Key(kCTForegroundColorAttributeName as String): color])
        let setter = CTFramesetterCreateWithAttributedString(string)
        context.saveGState(); context.translateBy(x: rect.minX, y: rect.maxY); context.scaleBy(x: 1, y: -1); context.textMatrix = .identity
        let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), CGPath(rect: CGRect(origin: .zero, size: rect.size), transform: nil), nil)
        // Keep CoreText's layout and glyph drawing, but do not emit whole lines
        // hidden by the current output page or original-page slice. A line cut
        // by the clip still draws on both sides so no visible glyph is lost.
        let lines = CTFrameGetLines(frame) as! [CTLine]
        var origins = Array(repeating: CGPoint.zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
        let clip = context.boundingBoxOfClipPath
        for (index, line) in lines.enumerated() {
            let bounds = CTLineGetImageBounds(line, nil).offsetBy(dx: origins[index].x, dy: origins[index].y)
            guard !bounds.isEmpty, bounds.intersects(clip) else { continue }
            context.saveGState()
            context.textPosition = origins[index]
            CTLineDraw(line, context)
            context.restoreGState()
        }
        context.restoreGState()
    }
}

#if canImport(UIKit)
struct PDFExtensionShare: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ view: UIActivityViewController, context: Context) {}
}
#endif
