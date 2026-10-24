import Foundation
import PDFKit
import CoreGraphics

enum BoardReadAloudPDF {
    enum Failure: Error, LocalizedError {
        case unavailable, locked, range, tooLarge
        var errorDescription: String? {
            switch self {
            case .unavailable: String(localized: "无法读取朗读用的 PDF，请确认文件仍可访问。")
            case .locked: String(localized: "请先解锁 PDF，再开始朗读。")
            case .range: String(localized: "请选择有效的 PDF 朗读页码。")
            case .tooLarge: String(localized: "这份 PDF 超过一次朗读的上限，请缩小页码范围；原文件未改变。")
            }
        }
    }

    /// A detached immutable file snapshot keeps UI PDFKit objects untouched.
    /// Native text is exact; only pages without a text layer use on-device OCR.
    static func prepare(url: URL, pages: ClosedRange<Int>?, customWords: [String],
                        progress: @escaping @Sendable (Int, Int) -> Void) async throws -> [BoardReadAloudLine] {
        let task = Task.detached(priority: .userInitiated) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
            let before = try url.resourceValues(forKeys: keys)
            guard before.isRegularFile == true, let size = before.fileSize, size > 0, size <= 256 * 1024 * 1024 else { throw Failure.tooLarge }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var data = Data()
            while true {
                try Task.checkCancellation()
                let chunk = try handle.read(upToCount: 1_048_576) ?? Data()
                if chunk.isEmpty { break }
                guard data.count + chunk.count <= 256 * 1024 * 1024 else { throw Failure.tooLarge }
                data.append(chunk)
            }
            let after = try url.resourceValues(forKeys: keys)
            guard after.fileSize == size, data.count == size, before.contentModificationDate == after.contentModificationDate,
                  let document = PDFDocument(data: data) else { throw Failure.unavailable }
            guard !document.isLocked else { throw Failure.locked }
            guard document.pageCount > 0 else { throw Failure.unavailable }
            let range = pages ?? 1...document.pageCount
            guard range.lowerBound >= 1, range.upperBound <= document.pageCount else { throw Failure.range }
            guard range.count <= 1000 else { throw Failure.tooLarge }
            var result: [BoardReadAloudLine] = [], totalCharacters = 0
            for (position, number) in range.enumerated() {
                try Task.checkCancellation()
                progress(position, range.count)
                guard let page = document.page(at: number - 1) else { throw Failure.unavailable }
                let text = page.string ?? ""
                guard text.utf16.count <= 300_000 else { throw Failure.tooLarge }
                let lines: [BoardReadAloudLine]
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    lines = try nativeLines(page: page, text: text, pageIndex: number - 1)
                } else {
                    let raster = try render(page)
                    lines = try await BoardReadAloudOCR.recognize(raster.image, customWords: customWords).map { line in
                        func pageRect(_ topLeft: CGRect) -> CGRect {
                            CGRect(x: topLeft.minX * raster.size.width, y: (1 - topLeft.maxY) * raster.size.height,
                                width: topLeft.width * raster.size.width, height: topLeft.height * raster.size.height)
                                .applying(raster.toPage)
                        }
                        return BoardReadAloudLine(text: line.text, rect: pageRect(line.rect),
                            words: line.words.map { BoardReadAloudWord(range: $0.range, rect: pageRect($0.rect)) },
                            confidence: line.confidence, pageIndex: number - 1)
                    }
                }
                totalCharacters += lines.reduce(0) { $0 + $1.text.utf16.count }
                guard totalCharacters <= 300_000, result.count + lines.count <= 20_000 else { throw Failure.tooLarge }
                result += lines
                progress(position + 1, range.count)
            }
            return result
        }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    private static func nativeLines(page: PDFPage, text: String, pageIndex: Int) throws -> [BoardReadAloudLine] {
        var lines: [BoardReadAloudLine] = []
        var ranges: [Range<String.Index>] = []
        text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: [.byLines, .substringNotRequired]) { _, range, _, _ in ranges.append(range) }
        for range in ranges {
            try Task.checkCancellation()
            let content = String(text[range])
            guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            let box = page.selection(for: NSRange(range, in: text))?.bounds(for: page) ?? page.bounds(for: .cropBox)
            guard !box.isNull, !box.isInfinite else { continue }
            var words: [BoardReadAloudWord] = []
            let base = NSRange(range, in: text).location
            content.enumerateSubstrings(in: content.startIndex..<content.endIndex, options: [.byWords, .substringNotRequired]) { _, wordRange, _, _ in
                let local = NSRange(wordRange, in: content)
                let global = NSRange(location: base + local.location, length: local.length)
                let wordRect = page.selection(for: global)?.bounds(for: page) ?? box
                words.append(BoardReadAloudWord(range: local, rect: wordRect))
            }
            lines.append(BoardReadAloudLine(text: content, rect: box, words: words, confidence: 1, pageIndex: pageIndex))
        }
        return lines
    }

    private static func render(_ page: PDFPage) throws -> (image: CGImage, size: CGSize, toPage: CGAffineTransform) {
        guard let pdf = page.pageRef else { throw Failure.unavailable }
        let crop = pdf.getBoxRect(.cropBox).standardized
        guard crop.width > 0, crop.height > 0, crop.width.isFinite, crop.height.isFinite else { throw Failure.unavailable }
        let rotated = abs(pdf.rotationAngle % 180) == 90
        let size = rotated ? CGSize(width: crop.height, height: crop.width) : crop.size
        let scale = min(2600 / max(size.width, size.height), sqrt(6_000_000 / (size.width * size.height)), 4)
        let width = max(1, Int(floor(size.width * scale))), height = max(1, Int(floor(size.height * scale)))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw Failure.unavailable }
        let pixels = CGSize(width: width, height: height)
        context.saveGState(); context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(origin: .zero, size: pixels)); context.restoreGState()
        context.scaleBy(x: pixels.width / size.width, y: pixels.height / size.height)
        context.concatenate(pdf.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true))
        let toPage = context.ctm.inverted()
        context.drawPDFPage(pdf)
        guard let image = context.makeImage() else { throw Failure.unavailable }
        return (image, pixels, toPage)
    }
}
