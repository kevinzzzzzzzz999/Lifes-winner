import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// A bounded one-page reading PDF. Original PNG/JPEG bytes are never rewritten.
/// ImageIO applies all EXIF rotations/mirrors during thumbnail creation.
enum ImageDocumentRenderer {
    static let maximumSourceBytes = 32 * 1_024 * 1_024
    static let rendererVersion = "image-reading-1"

    static func render(data: Data, fileExtension: String) async throws -> Data {
        let work = Task.detached(priority: .userInitiated) { try autoreleasepool { try renderImage(data: data, fileExtension: fileExtension) } }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await work.value
        } onCancel: { work.cancel() }
    }

    private static func renderImage(data: Data, fileExtension: String) throws -> Data {
        try Task.checkCancellation()
        guard ["png", "jpg", "jpeg"].contains(fileExtension.lowercased()), !data.isEmpty,
              data.count <= maximumSourceBytes else { throw ImageDocumentError.tooLarge }
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1, let identifier = CGImageSourceGetType(source),
              let type = UTType(identifier as String), type == .png || type == .jpeg,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
              width.isFinite, height.isFinite, width > 0, height > 0 else { throw ImageDocumentError.unreadable }
        guard width <= 100_000, height <= 100_000, width * height <= 120_000_000 else { throw ImageDocumentError.tooLarge }
        let ratio = min(width, height) / max(width, height)
        let maximumDimension = max(1, min(4096, Int(sqrt(12_000_000 / ratio))))
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumDimension]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw ImageDocumentError.unreadable }
        try Task.checkCancellation()
        guard image.width > 0, image.height > 0, image.width * image.height <= 12_100_000 else { throw ImageDocumentError.tooLarge }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        guard (1...8).contains(orientation) else { throw ImageDocumentError.unreadable }
        let rotated = (5...8).contains(orientation)
        let displayWidth = rotated ? height : width, displayHeight = rotated ? width : height
        let paperWidth = min(1440, displayWidth)
        var bounds = CGRect(x: 0, y: 0, width: paperWidth, height: paperWidth * displayHeight / displayWidth)
        guard bounds.height.isFinite, bounds.height > 0, bounds.height <= 200_000 else { throw ImageDocumentError.tooLarge }
        let output = NSMutableData()
        guard let consumer = CGDataConsumer(data: output as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &bounds, nil) else { throw ImageDocumentError.unreadable }
        context.beginPDFPage(nil)
        // Transparent pixels use the normal white paper background, never black.
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(bounds)
        context.interpolationQuality = .high; context.draw(image, in: bounds)
        context.endPDFPage(); context.closePDF()
        try Task.checkCancellation()
        guard output.length > 0, output.length <= 64 * 1_024 * 1_024 else { throw ImageDocumentError.tooLarge }
        return output as Data
    }
}

enum ImageDocumentError: LocalizedError {
    case unreadable, tooLarge
    var errorDescription: String? {
        switch self {
        case .unreadable: String(localized: "无法完整读取这张 PNG/JPEG 图片，尚未添加；请重新保存图片后重试。")
        case .tooLarge: String(localized: "图片超过本次处理容量（文件 32 MB、原图 1.2 亿像素），请缩小图片后重试。")
        }
    }
}
