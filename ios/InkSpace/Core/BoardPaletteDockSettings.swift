import Foundation
import CoreGraphics

/// Device-local presentation only. Tool order and attributes remain owned by
/// NativePaletteSettings/SavedPenSettings; this never changes board contents.
struct BoardPaletteDockSettings: Codable, Equatable {
    enum Edge: String, Codable, CaseIterable {
        case top, bottom, left, right
        var isVertical: Bool { self == .left || self == .right }
        var title: String {
            switch self {
            case .top: String(localized: "停靠上边")
            case .bottom: String(localized: "停靠下边")
            case .left: String(localized: "停靠左边")
            case .right: String(localized: "停靠右边")
            }
        }
    }
    static let defaultsKey = "InkSpace.paletteDock.v1"
    var edge: Edge = .bottom
    var isMinimized = false
    var usesSystemPalette = false

    static func load(from defaults: UserDefaults = .standard) -> Self {
        guard let data = defaults.data(forKey: defaultsKey),
              let value = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return value
    }

    func save(to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }

    /// Geometry is limited to the actual visible canvas, including small child
    /// canvases and split windows. Long lists scroll inside the bar.
    func frame(in available: CGRect, toolCount: Int) -> CGRect {
        guard !available.isNull, !available.isInfinite, available.width > 0, available.height > 0 else { return .zero }
        let area = available.insetBy(dx: min(8, available.width / 8), dy: min(8, available.height / 8))
        let compact = isMinimized || usesSystemPalette
        let length = compact ? 52 : CGFloat(max(1, toolCount)) * 52 + 3 * 44 + 12
        let width = min(area.width, edge.isVertical ? 60 : length)
        let height = min(area.height, edge.isVertical ? length : 60)
        switch edge {
        case .top: return CGRect(x: area.midX - width / 2, y: area.minY, width: width, height: height)
        case .bottom: return CGRect(x: area.midX - width / 2, y: area.maxY - height, width: width, height: height)
        case .left: return CGRect(x: area.minX, y: area.midY - height / 2, width: width, height: height)
        case .right: return CGRect(x: area.maxX - width, y: area.midY - height / 2, width: width, height: height)
        }
    }
}
