import Foundation
import CoreGraphics
import CoreText

struct PDFWorkspaceTranslatedPage: Codable, Identifiable, Sendable {
    let page: Int
    let text: String
    var id: Int { page }
}

enum PDFWorkspaceTranslationExportError: LocalizedError {
    case invalid, tooLarge, unavailable, timedOut
    var errorDescription: String? {
        switch self {
        case .invalid: String(localized: "译文页码或内容不完整，请检查已完成页后重试导出。")
        case .tooLarge: String(localized: "本次译文超过导出范围，请分批导出；已有译文保持不变。")
        case .unavailable: String(localized: "译文 PDF 暂时无法生成，请检查本机空间后重试。")
        case .timedOut: String(localized: "译文 PDF 生成超时，请缩小导出范围后重试。")
        }
    }
}

/// A new, reflowed reading copy. No source URL, HTML, API key or original PDF
/// data is accepted by this exporter. CoreText handles Chinese and mixed-script
/// fallback; every source page starts a new output page and retains its label.
enum PDFWorkspaceTranslationExport {
    static let maximumCharacters = 2_000_000
    static let maximumPageCharacters = 60_000
    static let maximumPDFBytes = 128 * 1024 * 1024

    static func export(title: String, provider: String, model: String, language: String,
                       range: ClosedRange<Int>, pages: [PDFWorkspaceTranslatedPage], status: String) async throws -> URL {
        let task = Task.detached(priority: .userInitiated) {
            try render(title: title, provider: provider, model: model, language: language,
                       range: range, pages: pages, status: status)
        }
        return try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
    }

    private static func validText(_ value: String, maximum: Int, allowEmpty: Bool = false) -> Bool {
        (allowEmpty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            && value.unicodeScalars.count <= maximum && !value.contains("\0")
    }

    private static func render(title: String, provider: String, model: String, language: String,
                               range: ClosedRange<Int>, pages: [PDFWorkspaceTranslatedPage], status: String) throws -> URL {
        try Task.checkCancellation()
        guard validText(title, maximum: 1024), validText(provider, maximum: 120), validText(model, maximum: 120),
              validText(language, maximum: 80), ["complete", "cancelled", "failed", "capacity"].contains(status),
              range.lowerBound >= 1, range.upperBound <= 100_000, range.upperBound - range.lowerBound < 2000,
              !pages.isEmpty, pages.count <= 2000, Set(pages.map(\.page)).count == pages.count,
              pages.allSatisfy({ range.contains($0.page) && validText($0.text, maximum: maximumPageCharacters) }) else {
            throw PDFWorkspaceTranslationExportError.invalid
        }
        guard pages.reduce(0, { $0 + $1.text.unicodeScalars.count }) <= maximumCharacters else {
            throw PDFWorkspaceTranslationExportError.tooLarge
        }
        let sorted = pages.sorted { $0.page < $1.page }
        let present = Set(sorted.map(\.page)), omitted = range.filter { !present.contains($0) }
        guard status != "complete" || omitted.isEmpty else { throw PDFWorkspaceTranslationExportError.invalid }
        let zh = language == "zh-Hans" || language.contains("中文") || language.lowercased().contains("chinese")
        let label: (String, String) -> String = { zh ? $0 : $1 }
        let sourceTitle = (title as NSString).lastPathComponent
        let exportTitle = sourceTitle + label(" · 译文", " · Translation")
        let state: String
        switch status {
        case "complete": state = label("已完成", "Complete")
        case "cancelled": state = label("已取消，保留已完成页", "Cancelled; completed pages retained")
        case "capacity": state = label("已到本次容量，保留已完成页", "Capacity reached; completed pages retained")
        default: state = label("未全部完成", "Incomplete")
        }
        let metadata = [label("这是重新排版的译文，并非原版式复制。请对照原文检查表格、公式和术语。",
                              "This is a reflowed translation, not the original layout. Compare tables, formulas and terminology with the source."),
                        "\(provider) · \(model) · \(language)",
                        label("原文页码", "Source pages") + ": \(range.lowerBound)–\(range.upperBound) · " + state,
                        omitted.isEmpty ? "" : label("未包含原页", "Omitted source pages") + ": " + compactPageRanges(omitted)].filter { !$0.isEmpty }.joined(separator: "\n")
        let fm = FileManager.default
        let directory = fm.temporaryDirectory.appendingPathComponent("InkSpace-PDF-Translation-" + UUID().uuidString.lowercased(), isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var filename = String(sourceTitle.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_").prefix(80))
        while filename.utf8.count > 180 { filename.removeLast() }
        let output = directory.appendingPathComponent((filename.isEmpty ? "Reading" : filename) + ".translation.pdf")
        var completed = false
        defer { if !completed { try? fm.removeItem(at: directory) } }
        guard let consumer = CGDataConsumer(url: output as CFURL) else { throw PDFWorkspaceTranslationExportError.unavailable }
        var mediaBox = CGRect(x: 0, y: 0, width: 612, height: 792)
        let info = [kCGPDFContextTitle as String: exportTitle, kCGPDFContextCreator as String: "人生赢家"] as CFDictionary
        guard let context = CGContext(consumer: consumer, mediaBox: &mediaBox, info) else { throw PDFWorkspaceTranslationExportError.unavailable }
        var closed = false
        defer { if !closed { context.closePDF() } }
        let started = Date()
        var outputPage = 0
        func budget() throws {
            try Task.checkCancellation()
            guard Date().timeIntervalSince(started) < 60 else { throw PDFWorkspaceTranslationExportError.timedOut }
            guard outputPage < 12_000 else { throw PDFWorkspaceTranslationExportError.tooLarge }
            let bytes = (try? fm.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0
            guard bytes <= maximumPDFBytes else { throw PDFWorkspaceTranslationExportError.tooLarge }
        }
        func drawSection(heading: String, content: String, sourcePage: Int?) throws {
            let attributed = attributedText(content, size: 12)
            let setter = CTFramesetterCreateWithAttributedString(attributed as CFAttributedString)
            var offset = 0, continuation = false
            repeat {
                try budget()
                context.beginPDFPage(nil); outputPage += 1
                context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(mediaBox)
                drawText(sourceTitle, in: CGRect(x: 54, y: 734, width: 504, height: 28), size: 10, context: context)
                drawText(heading + (continuation ? label("（续）", " (continued)") : ""),
                         in: CGRect(x: 54, y: 688, width: 504, height: 42), size: 16, context: context)
                let path = CGMutablePath(); path.addRect(CGRect(x: 54, y: 72, width: 504, height: 604))
                let frame = CTFramesetterCreateFrame(setter, CFRange(location: offset, length: 0), path, nil)
                CTFrameDraw(frame, context)
                let visible = CTFrameGetVisibleStringRange(frame)
                let footer = label("PDF 第 \(outputPage) 页", "PDF page \(outputPage)")
                    + (sourcePage.map { " · " + label("原文第 \($0) 页", "Source page \($0)") } ?? "")
                drawText(footer, in: CGRect(x: 54, y: 26, width: 504, height: 25), size: 9, context: context, centered: true)
                context.endPDFPage()
                guard visible.length > 0 else { throw PDFWorkspaceTranslationExportError.unavailable }
                offset += visible.length; continuation = true
            } while offset < attributed.length
        }
        do {
            try drawSection(heading: exportTitle, content: metadata, sourcePage: nil)
            for page in sorted {
                try drawSection(heading: label("原文第 \(page.page) 页", "Source page \(page.page)"), content: page.text, sourcePage: page.page)
            }
            context.closePDF(); closed = true
            try Task.checkCancellation()
            let attributes = try fm.attributesOfItem(atPath: output.path)
            guard let size = (attributes[.size] as? NSNumber)?.intValue, size > 5, size <= maximumPDFBytes else { throw PDFWorkspaceTranslationExportError.tooLarge }
            guard Date().timeIntervalSince(started) < 60 else { throw PDFWorkspaceTranslationExportError.timedOut }
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
            let handle = try FileHandle(forWritingTo: output)
            do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
            completed = true
            return output
        } catch { throw error }
    }

    private static func attributedText(_ value: String, size: CGFloat, centered: Bool = false) -> NSAttributedString {
        let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
        var alignment = centered ? CTTextAlignment.center : CTTextAlignment.left
        var spacing: CGFloat = 4
        let style: CTParagraphStyle = withUnsafePointer(to: &alignment) { alignmentPointer in
            withUnsafePointer(to: &spacing) { spacingPointer in
                let settings = [CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: alignmentPointer),
                                CTParagraphStyleSetting(spec: .lineSpacingAdjustment, valueSize: MemoryLayout<CGFloat>.size, value: spacingPointer)]
                return CTParagraphStyleCreate(settings, settings.count)
            }
        }
        return NSAttributedString(string: value, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font,
             NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.08, alpha: 1),
             NSAttributedString.Key(kCTParagraphStyleAttributeName as String): style])
    }
    private static func drawText(_ value: String, in rect: CGRect, size: CGFloat, context: CGContext, centered: Bool = false) {
        let setter = CTFramesetterCreateWithAttributedString(attributedText(value, size: size, centered: centered) as CFAttributedString)
        let path = CGMutablePath(); path.addRect(rect)
        CTFrameDraw(CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil), context)
    }
    private static func compactPageRanges(_ pages: [Int]) -> String {
        var result: [String] = [], index = 0
        while index < pages.count {
            let start = pages[index]; var end = start
            while index + 1 < pages.count && pages[index + 1] == end + 1 { index += 1; end = pages[index] }
            result.append(start == end ? String(start) : "\(start)–\(end)"); index += 1
        }
        return result.joined(separator: ", ")
    }
}
