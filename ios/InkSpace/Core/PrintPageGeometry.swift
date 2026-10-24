import Foundation
import CoreGraphics

enum BoardPrintOrientation: String, Codable, CaseIterable, Identifiable, Sendable {
    case portrait, landscape
    var id: String { rawValue }
    var title: String { self == .portrait ? String(localized: "竖向") : String(localized: "横向") }
    var paperSize: CGSize { self == .portrait ? CGSize(width: 612, height: 792) : CGSize(width: 792, height: 612) }
    var contentRect: CGRect { CGRect(origin: .zero, size: paperSize).insetBy(dx: 36, dy: 36) }
}

enum BoardPrintSplitMode: String, CaseIterable, Identifiable, Sendable {
    case fit, tile
    var id: String { rawValue }
    var title: String { self == .fit ? String(localized: "缩放放进一页") : String(localized: "保持比例分成多页") }
}

/// The rectangle is a world-coordinate CONTENT region, not a new document/card.
/// Array order is page order. A fractional clip keeps an irregular last tile or
/// fitted selection from silently including material outside the selected area.
struct BoardPrintFrame: Codable, Identifiable, Equatable, Sendable {
    var id: UUID = UUID()
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var orientation: BoardPrintOrientation = .portrait
    var normalizedClip: CGRect? = nil
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    var sourceRect: CGRect { rect }
    var paperSize: CGSize { orientation.paperSize }
    var contentRect: CGRect { orientation.contentRect }
    var pdfScale: CGFloat { contentRect.width / CGFloat(width) }
    var clippedSourceRect: CGRect {
        guard let normalizedClip else { return rect }
        return CGRect(x: x + normalizedClip.minX * width, y: y + normalizedClip.minY * height,
                      width: normalizedClip.width * width, height: normalizedClip.height * height)
    }
}

enum BoardPrintError: LocalizedError {
    case invalidGeometry, tooManyPages, regionTooLarge, invalidDrawing
    case missingSource(String), unreadableSource(String), unavailableFormula(String), cancelled, outputFailed
    var errorDescription: String? {
        switch self {
        case .invalidGeometry: String(localized: "打印范围或比例无效，或已超出白板边界。请调整打印框后重试。")
        case .tooManyPages: String(localized: "一次最多导出 2000 页，请减少打印框后分批导出。")
        case .regionTooLarge: String(localized: "选择区超过单页或长图容量。请使用打印框分成多页，或缩小选择区。")
        case .invalidDrawing: String(localized: "无法完整读取手写笔迹，已停止导出。白板原内容保持不变。")
        case .missingSource(let path): String(localized: "导出所需的原文件不可用：\(path)。请先下载文件或恢复原位置。")
        case .unreadableSource(let path): String(localized: "无法完整读取文档页面：\(path)。未生成缺页的导出文件。")
        case .unavailableFormula(let title): String(localized: "公式无法完整排版：\(title)。请修正公式后再导出。")
        case .cancelled: String(localized: "已取消导出。")
        case .outputFailed: String(localized: "导出文件未能完整生成，请检查可用空间后重试。")
        }
    }
}

enum PrintPageGeometry {
    static let maximumPages = 2_000
    static let margin: CGFloat = 36

    /// Fit expands a content-aspect rectangle at the chosen top-left; the original
    /// selection is its clip. Tiling advances by CONTENT size, without visual gaps.
    static func frames(for region: CGRect, orientation: BoardPrintOrientation = .portrait,
                       mode: BoardPrintSplitMode = .tile, scale: Double = 1,
                       canvasSize: Double = 8_000_000) throws -> [BoardPrintFrame] {
        guard valid(region), validCanvas(canvasSize), region.minX >= 0, region.minY >= 0,
              region.maxX <= canvasSize, region.maxY <= canvasSize,
              scale.isFinite, (0.1...10).contains(scale) else { throw BoardPrintError.invalidGeometry }
        let content = orientation.contentRect.size
        if mode == .fit {
            let width = max(region.width, region.height * content.width / content.height)
            let height = width * content.height / content.width
            let frame = BoardPrintFrame(x: region.minX, y: region.minY, width: width, height: height,
                                        orientation: orientation,
                                        normalizedClip: CGRect(x: 0, y: 0, width: region.width / width, height: region.height / height))
            try validate(frames: [frame], canvasSize: canvasSize)
            return [frame]
        }
        let width = content.width / scale, height = content.height / scale
        let columnsDouble = ceil(region.width / width), rowsDouble = ceil(region.height / height)
        guard columnsDouble <= Double(maximumPages), rowsDouble <= Double(maximumPages),
              columnsDouble * rowsDouble <= Double(maximumPages) else { throw BoardPrintError.tooManyPages }
        let columns = Int(columnsDouble), rows = Int(rowsDouble)
        var result: [BoardPrintFrame] = []
        for row in 0..<rows {
            for column in 0..<columns {
                let x = region.minX + CGFloat(column) * width, y = region.minY + CGFloat(row) * height
                let visibleWidth = min(width, region.maxX - x), visibleHeight = min(height, region.maxY - y)
                result.append(BoardPrintFrame(x: x, y: y, width: width, height: height, orientation: orientation,
                    normalizedClip: CGRect(x: 0, y: 0, width: visibleWidth / width, height: visibleHeight / height)))
            }
        }
        try validate(frames: result, canvasSize: canvasSize)
        return result
    }

    static func validate(frames: [BoardPrintFrame], canvasSize: Double = 8_000_000) throws {
        guard frames.count <= maximumPages else { throw BoardPrintError.tooManyPages }
        guard validCanvas(canvasSize) else { throw BoardPrintError.invalidGeometry }
        var ids = Set<UUID>()
        for frame in frames {
            guard ids.insert(frame.id).inserted, valid(frame.rect), frame.x >= 0, frame.y >= 0,
                  frame.rect.maxX <= canvasSize, frame.rect.maxY <= canvasSize,
                  abs(frame.width / frame.height - frame.contentRect.width / frame.contentRect.height) <= 0.000_001 else {
                throw BoardPrintError.invalidGeometry
            }
            if let clip = frame.normalizedClip {
                guard valid(clip), clip.minX >= 0, clip.minY >= 0,
                      clip.maxX <= 1.000_000_1, clip.maxY <= 1.000_000_1 else { throw BoardPrintError.invalidGeometry }
            }
        }
    }

    static func valid(_ rect: CGRect) -> Bool {
        [rect.origin.x, rect.origin.y, rect.size.width, rect.size.height, rect.maxX, rect.maxY].allSatisfy(\.isFinite)
            && rect.width > 0 && rect.height > 0
    }
    private static func validCanvas(_ size: Double) -> Bool { size.isFinite && size > 0 && size <= 8_000_000 }
}
