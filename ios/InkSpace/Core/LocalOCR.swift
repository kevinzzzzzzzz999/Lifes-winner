import Foundation
import Vision
import CoreGraphics
import ImageIO
import PDFKit

/// Shares recognition/rendering limits with the Mac helper and retains iPad
/// coordinated image preview APIs. Input is read into a
/// bounded snapshot; OCR never opens an output stream or modifies the source.
enum LocalOCR {
    static let maximumPDFBytes = 256 * 1024 * 1024
    static let maximumImageBytes = 64 * 1024 * 1024
    static let defaultPageLimit = 10
    static let maximumPages = 50
    static let maximumDimension = 4096
    static let maximumPixels = 12_000_000
    static let maximumOriginalImagePixels = 80_000_000
    static let maximumPageCharacters = 30_000
    static let maximumCharacters = 200_000
    static var notice: String {
        NSLocalizedString("OCR 在本机识别中英文，不上传文件。数学公式、手写和复杂排版可能不准确，请核对原文。", comment: "")
    }

    struct TextBox: Codable, Sendable {
        let text: String
        // Normalized image coordinates, origin at top left.
        let x: Double, y: Double, width: Double, height: Double
    }
    struct Page: Codable, Sendable {
        let page: Int
        let text: String
        /// Nil means the page completed with text. Empty/scanned pages that
        /// produce no text and bounded truncation are reported explicitly.
        let error: String?
        var boxes: [TextBox] = []
    }
    struct Result: Codable, Sendable {
        let pageCount: Int
        let requestedPages: [Int]
        let pages: [Page]
        let cancelled: Bool
        let outputLimited: Bool
    }
    struct Progress: Sendable {
        let completed: Int
        let total: Int
        let page: Int
    }
    enum Failure: Error, LocalizedError {
        case unsupported, unavailable, tooLarge, invalidPageRange, lockedPDF, invalidGeometry, recognitionUnavailable
        var errorDescription: String? {
            switch self {
            case .unsupported: NSLocalizedString("本机 OCR 仅支持 PDF 和可读取的图片。", comment: "")
            case .unavailable: NSLocalizedString("无法读取 OCR 原文件，请确认文件已下载且仍可访问。", comment: "")
            case .tooLarge: NSLocalizedString("文件超过本机 OCR 处理上限：PDF 256 MB、图片 64 MB 或 8000 万像素。", comment: "")
            case .invalidPageRange: NSLocalizedString("请选择有效页码，每次 OCR 最多识别 50 页。", comment: "")
            case .lockedPDF: NSLocalizedString("这份 PDF 已加密，请先使用可阅读的未加密副本。", comment: "")
            case .invalidGeometry: NSLocalizedString("这一页的尺寸无效，无法生成 OCR 图像。", comment: "")
            case .recognitionUnavailable: NSLocalizedString("本机中英文 OCR 暂不可用，请稍后重试。", comment: "")
            }
        }
    }

    private static let queue = DispatchQueue(label: "InkSpace.LocalOCR", qos: .userInitiated)

    /// Pass currentPage...currentPage for a PDF reader's default current-page
    /// action. Nil recognizes a PDF's first ten pages, or one still image.
    /// Progress runs off the main actor. Task cancellation cancels Vision and
    /// returns already completed pages with cancelled=true.
    static func recognize(url: URL, pages: ClosedRange<Int>? = nil, customWords: [String] = [],
                          progress: (@Sendable (Progress) -> Void)? = nil) async throws -> Result {
        let control = OCRCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    do { continuation.resume(returning: try run(url: url, range: pages, customWords: customWords, progress: progress, control: control)) }
                    catch is CancellationError { continuation.resume(returning: Result(pageCount: 0, requestedPages: [], pages: [], cancelled: true, outputLimited: false)) }
                    catch { continuation.resume(throwing: error) }
                }
            }
        } onCancel: { control.cancel() }
    }

    /// Oriented, bounded pixels shared by the displayed image and native
    /// Live Text geometry. File Provider reads remain coordinated/cancellable.
    static func imageForSelection(url: URL) async throws -> CGImage {
        let control = OCRCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.async {
                    do {
                        let image = try autoreleasepool {
                            let access = url.startAccessingSecurityScopedResource()
                            defer { if access { url.stopAccessingSecurityScopedResource() } }
                            try control.check()
                            let data = try coordinatedImageSnapshot(url, control: control)
                            guard data.count <= maximumImageBytes,
                                  let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { throw Failure.unavailable }
                            try validateImage(source)
                            let image = try OCRSource.image(source).image(page: 1)
                            try control.check()
                            return image
                        }
                        continuation.resume(returning: image)
                    } catch { continuation.resume(throwing: error) }
                }
            }
        } onCancel: { control.cancel() }
    }

    private static func run(url: URL, range: ClosedRange<Int>?, customWords: [String], progress: (@Sendable (Progress) -> Void)?, control: OCRCancellation) throws -> Result {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let input = try readSnapshot(url, control: control)
        try control.check()
        let source: OCRSource
        if input.starts(with: Data("%PDF-".utf8)) {
            guard let provider = CGDataProvider(data: input as CFData), let pdf = CGPDFDocument(provider) else { throw Failure.unavailable }
            guard !pdf.isEncrypted || pdf.isUnlocked else { throw Failure.lockedPDF }
            guard pdf.numberOfPages > 0, pdf.numberOfPages <= 100_000 else { throw Failure.tooLarge }
            source = .pdf(pdf, PDFDocument(data: input))
        } else {
            guard input.count <= maximumImageBytes else { throw Failure.tooLarge }
            guard let image = CGImageSourceCreateWithData(input as CFData, [kCGImageSourceShouldCache: false] as CFDictionary), CGImageSourceGetCount(image) > 0 else { throw Failure.unsupported }
            try validateImage(image)
            source = .image(image)
        }
        let count = source.pageCount
        let requested = try selectedPages(range: range, pageCount: count)
        var result: [Page] = [], totalCharacters = 0, outputLimited = false
        for number in requested {
            if control.isCancelled { break }
            progress?(Progress(completed: result.count, total: requested.count, page: number))
            let page: Page
            do {
                page = try autoreleasepool {
                    // Embedded Unicode text is authoritative and avoids OCR errors.
                    // Scanned/invalid text layers continue through local Vision.
                    let boxes: [TextBox]
                    if let native = try source.nativeText(page: number), !native.isEmpty {
                        boxes = native
                    } else {
                        let image = try source.image(page: number)
                        try control.check()
                        boxes = try recognizeImage(image, customWords: customWords, control: control)
                    }
                    let text = boxes.map(\.text).joined(separator: "\n")
                    try control.check()
                    let allowance = min(maximumPageCharacters, maximumCharacters - totalCharacters)
                    let clipped = text.unicodeScalars.count > allowance
                    let bounded = clipped ? String(text.unicodeScalars.prefix(allowance)) : text
                    if clipped { outputLimited = true }
                    let error = clipped ? NSLocalizedString("这一页的 OCR 文字已达到输出上限，请缩小范围后重试。", comment: "") :
                        bounded.isEmpty ? NSLocalizedString("这一页未识别到文字；请检查清晰度、方向和原文内容。", comment: "") : nil
                    return Page(page: number, text: bounded, error: error, boxes: clipped ? [] : boxes)
                }
            } catch is CancellationError { break }
            catch {
                if control.isCancelled { break }
                page = Page(page: number, text: "", error: (error as? Failure)?.localizedDescription ?? NSLocalizedString("这一页 OCR 失败，已保留其他页的识别结果。", comment: ""))
            }
            result.append(page); totalCharacters += page.text.unicodeScalars.count
            progress?(Progress(completed: result.count, total: requested.count, page: number))
            if totalCharacters >= maximumCharacters { outputLimited = true; break }
        }
        return Result(pageCount: count, requestedPages: requested, pages: result, cancelled: control.isCancelled, outputLimited: outputLimited)
    }

    /// Kept independent of Vision so callers/tests can validate a range before
    /// doing expensive work. Never silently clips an explicit invalid range.
    static func selectedPages(range: ClosedRange<Int>?, pageCount: Int) throws -> [Int] {
        guard pageCount > 0 else { throw Failure.invalidPageRange }
        if let range {
            guard range.lowerBound >= 1, range.upperBound <= pageCount,
                  range.upperBound - range.lowerBound < maximumPages else { throw Failure.invalidPageRange }
            return Array(range)
        }
        return Array(1...min(pageCount, defaultPageLimit))
    }

    /// Reads in chunks without memory mapping or asking an image/PDF decoder to
    /// allocate before the compressed-byte budget is checked.
    private static func coordinatedImageSnapshot(_ url: URL, control: OCRCancellation) throws -> Data {
        guard url.isFileURL else { throw Failure.unsupported }
        let coordinator = NSFileCoordinator()
        try control.install(coordinator)
        let timeout = DispatchWorkItem { coordinator.cancel() }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 25, execute: timeout)
        defer { timeout.cancel(); control.clearCoordinator() }
        var coordinationError: NSError?
        var result: Swift.Result<Data, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { accessedURL in
            result = Swift.Result {
                try control.check()
                return try readSnapshot(accessedURL, control: control, maximumBytes: maximumImageBytes)
            }
        }
        try control.check()
        if let coordinationError { throw coordinationError }
        guard let result else { throw Failure.unavailable }
        return try result.get()
    }

    private static func readSnapshot(_ url: URL, control: OCRCancellation, maximumBytes: Int = maximumPDFBytes) throws -> Data {
        guard url.isFileURL else { throw Failure.unsupported }
        let values: URLResourceValues
        do { values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]) }
        catch { throw Failure.unavailable }
        guard values.isRegularFile == true, let size = values.fileSize, size > 0 else { throw Failure.unavailable }
        guard size <= min(maximumPDFBytes, maximumBytes) else { throw Failure.tooLarge }
        let handle: FileHandle
        do { handle = try FileHandle(forReadingFrom: url) } catch { throw Failure.unavailable }
        defer { try? handle.close() }
        let prefix = try handle.read(upToCount: 8) ?? Data()
        let budget = min(maximumBytes, prefix.starts(with: Data("%PDF-".utf8)) ? maximumPDFBytes : maximumImageBytes)
        guard size <= budget else { throw Failure.tooLarge }
        var data = prefix
        while true {
            try control.check()
            let chunk = try handle.read(upToCount: 1_048_576) ?? Data()
            if chunk.isEmpty { break }
            guard chunk.count <= budget - data.count else { throw Failure.tooLarge }
            data.append(chunk)
        }
        let after = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        guard data.count == size, after.fileSize == size, after.contentModificationDate == values.contentModificationDate else { throw Failure.unavailable }
        return data
    }

    private static func validateImage(_ source: CGImageSource) throws {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else { throw Failure.unsupported }
        let w = width.doubleValue, h = height.doubleValue
        guard w.isFinite, h.isFinite, w >= 1, h >= 1, w <= 30_000, h <= 30_000, w*h <= Double(maximumOriginalImagePixels) else { throw Failure.tooLarge }
    }

    private static func recognizeImage(_ image: CGImage, customWords: [String], control: OCRCancellation) throws -> [TextBox] {
        guard image.width <= maximumDimension, image.height <= maximumDimension, image.width * image.height <= maximumPixels else { throw Failure.tooLarge }
        let request = VNRecognizeTextRequest()
        if #available(macOS 13.0, iOS 16.0, *) { request.revision = VNRecognizeTextRequestRevision3 }
        else { request.revision = VNRecognizeTextRequestRevision2 }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        var vocabulary = Set<String>()
        request.customWords = Array(customWords.map { $0.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !$0.contains("\0") && $0.unicodeScalars.count <= 80 && vocabulary.insert($0).inserted }.prefix(200))
        request.minimumTextHeight = 0.003
        let languages: [String]
        if #available(macOS 12.0, iOS 15.0, *) { languages = try request.supportedRecognitionLanguages() }
        else { languages = try VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: request.revision) }
        request.recognitionLanguages = ["zh-Hans", "en-US", "zh-Hant"].filter(languages.contains)
        guard !request.recognitionLanguages.isEmpty else { throw Failure.recognitionUnavailable }
        if #available(macOS 13.0, iOS 16.0, *) { request.automaticallyDetectsLanguage = true }
        try control.install(request)
        defer { control.clear() }
        try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
        try control.check()
        let observations = (request.results ?? []).sorted {
            if $0.boundingBox.maxY != $1.boundingBox.maxY { return $0.boundingBox.maxY > $1.boundingBox.maxY }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        return observations.compactMap { observation in
            guard let text = observation.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            let box = observation.boundingBox
            return TextBox(text: text, x: Double(box.minX), y: Double(1 - box.maxY), width: Double(box.width), height: Double(box.height))
        }
    }

    private enum OCRSource {
        case pdf(CGPDFDocument, PDFDocument?), image(CGImageSource)
        var pageCount: Int { if case .pdf(let pdf, _) = self { pdf.numberOfPages } else { 1 } }
        func nativeText(page number: Int) throws -> [TextBox]? {
            guard case .pdf(let original, let document) = self, let page = document?.page(at: number - 1),
                  let raw = page.string, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !raw.contains("\0"), !raw.contains("\u{FFFD}"), raw.utf16.count <= 1_000_000,
                  let cgPage = original.page(at: number) else { return nil }
            let crop = cgPage.getBoxRect(.cropBox).standardized
            guard crop.width.isFinite, crop.height.isFinite, crop.width > 0, crop.height > 0 else { return nil }
            let rotated = abs(cgPage.rotationAngle % 180) == 90
            let size = rotated ? CGSize(width: crop.height, height: crop.width) : crop.size
            let destination = CGRect(origin: .zero, size: size)
            let transform = cgPage.getDrawingTransform(.cropBox, rect: destination, rotate: 0, preserveAspectRatio: true)
            var boxes: [TextBox] = []
            raw.enumerateSubstrings(in: raw.startIndex..<raw.endIndex, options: [.byLines]) { line, range, _, stop in
                if boxes.count >= maximumPageCharacters { stop = true; return }
                guard let text = line?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
                      let selected = page.selection(for: NSRange(range, in: raw)) else { return }
                let rect = selected.bounds(for: page).applying(transform).standardized.intersection(destination)
                guard !rect.isNull, rect.width > 0, rect.height > 0,
                      [rect.minX,rect.minY,rect.width,rect.height].allSatisfy({ $0.isFinite }) else { return }
                boxes.append(TextBox(text: text, x: Double(rect.minX/size.width),
                    y: Double(1-rect.maxY/size.height), width: Double(rect.width/size.width), height: Double(rect.height/size.height)))
            }
            return boxes.isEmpty ? nil : boxes
        }
        func image(page number: Int) throws -> CGImage {
            switch self {
            case .image(let source):
                // Preserve long rectangular pages up to the shared bounded
                // budget; a square-only limit needlessly blurred narrow scans.
                let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
                let w = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 1
                let h = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 1
                let scale = min(1, Double(maximumDimension)/max(w,h), sqrt(Double(maximumPixels)/(w*h)))
                let dimension = min(maximumDimension, max(1, Int(floor(max(w,h)*scale))))
                let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceThumbnailMaxPixelSize: dimension]
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw Failure.unavailable }
                return image
            case .pdf(let pdf, _):
                guard let page = pdf.page(at: number) else { throw Failure.invalidPageRange }
                let box = page.getBoxRect(.cropBox).standardized
                guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0,
                      box.width <= 1_000_000, box.height <= 1_000_000 else { throw Failure.invalidGeometry }
                let rotated = abs(page.rotationAngle % 180) == 90
                let size = rotated ? CGSize(width:box.height,height:box.width) : box.size
                let scale = min(CGFloat(maximumDimension)/max(size.width,size.height),sqrt(CGFloat(maximumPixels)/(size.width*size.height)),4)
                let width = max(1,Int(floor(size.width*scale))), height = max(1,Int(floor(size.height*scale)))
                guard width <= maximumDimension, height <= maximumDimension, width*height <= maximumPixels,
                      let context = CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,
                        space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { throw Failure.invalidGeometry }
                let bounds = CGRect(x:0,y:0,width:width,height:height)
                // A valid PDF may rely on the initial black fill rather than
                // emit a color operator. Do not let our white background leak
                // into the PDF's graphics state and turn its text white.
                context.saveGState()
                context.setFillColor(CGColor(gray:1,alpha:1)); context.fill(bounds)
                context.restoreGState()
                // CGPDF's fitting transform may center without upscaling on
                // iOS. Apply the pixel scale ourselves, then ask it only for
                // the crop origin and page rotation in PDF-point coordinates.
                context.scaleBy(x:CGFloat(width)/size.width,y:CGFloat(height)/size.height)
                context.concatenate(page.getDrawingTransform(.cropBox,rect:CGRect(origin:.zero,size:size),rotate:0,preserveAspectRatio:true))
                context.drawPDFPage(page)
                guard let image = context.makeImage() else { throw Failure.invalidGeometry }
                return image
            }
        }
    }
}

private final class OCRCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var request: VNRequest?
    private var coordinator: NSFileCoordinator?
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func check() throws { if isCancelled { throw CancellationError() } }
    func install(_ request: VNRequest) throws {
        lock.lock()
        if cancelled { lock.unlock(); throw CancellationError() }
        self.request = request; lock.unlock()
    }
    func install(_ coordinator: NSFileCoordinator) throws {
        lock.lock()
        if cancelled { lock.unlock(); coordinator.cancel(); throw CancellationError() }
        self.coordinator = coordinator; lock.unlock()
    }
    func clearCoordinator() { lock.lock(); coordinator = nil; lock.unlock() }
    func clear() { lock.lock(); request = nil; lock.unlock() }
    func cancel() {
        lock.lock(); cancelled = true; let active = request; let fileRead = coordinator; lock.unlock()
        active?.cancel(); fileRead?.cancel()
    }
}
