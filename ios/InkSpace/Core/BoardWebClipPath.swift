import CoreGraphics
import Foundation
import PencilKit

/// Bounded numeric commands shared by native ink and browser previews. Coordinates
/// are in world space; no executable SVG or user-provided path string is stored.
enum BoardWebClipPath {
    static let maximumCommands = 10_000
    static let maximumTotalCommands = 100_000

    /// PencilKit may normalize monoline into pen when archiving. Identify the
    /// auxiliary strip by its three collinear, constant-width control points.
    /// Other existing masked freehand strokes retain their old sampling path.
    static func isAuxiliaryFill(_ stroke: PKStroke) -> Bool {
        guard stroke.mask != nil, stroke.path.count == 3 else { return false }
        let points = (0..<3).map { stroke.path[$0] }
        let a = points[0].location, b = points[2].location
        let dx = b.x - a.x, dy = b.y - a.y, length = hypot(dx, dy)
        guard length.isFinite, length > 0 else { return false }
        let mid = points[1].location
        guard abs((mid.x - a.x) * dy - (mid.y - a.y) * dx) / length <= 0.5 else { return false }
        let widths = points.map { ($0.size.width + $0.size.height) / 2 }
        guard widths.allSatisfy({ $0.isFinite && $0 > 0 }), let low = widths.min(), let high = widths.max() else { return false }
        return high - low <= max(0.5, high * 0.001)
    }

    static func commands(from path: CGPath, transform: CGAffineTransform) -> [[Double]]? {
        var output: [[Double]] = []
        var valid = true
        path.applyWithBlock { pointer in
            guard valid else { return }
            let element = pointer.pointee
            var values: [Double]
            let count: Int
            switch element.type {
            case .moveToPoint: values = [0]; count = 1
            case .addLineToPoint: values = [1]; count = 1
            case .addQuadCurveToPoint: values = [2]; count = 2
            case .addCurveToPoint: values = [3]; count = 3
            case .closeSubpath: values = [4]; count = 0
            @unknown default: valid = false; return
            }
            for index in 0..<count {
                let point = element.points[index].applying(transform)
                guard point.x.isFinite, point.y.isFinite,
                      abs(point.x) <= 8_000_000, abs(point.y) <= 8_000_000 else { valid = false; return }
                values += [Double(point.x), Double(point.y)]
            }
            output.append(values)
            if output.count > maximumCommands { valid = false }
        }
        return valid ? output : nil
    }

    static func path(from commands: [[Double]]) throws -> CGPath {
        guard commands.count <= maximumCommands else { throw BoardFormatError.invalidGeometry }
        let path = CGMutablePath()
        var hasCurrentPoint = false
        for command in commands {
            guard let kind = command.first, command.allSatisfy(\.isFinite),
                  command.dropFirst().allSatisfy({ abs($0) <= 8_000_000 }) else { throw BoardFormatError.invalidGeometry }
            switch kind {
            case 0:
                guard command.count == 3 else { throw BoardFormatError.invalidGeometry }
                path.move(to: CGPoint(x: command[1], y: command[2])); hasCurrentPoint = true
            case 1:
                guard command.count == 3, hasCurrentPoint else { throw BoardFormatError.invalidGeometry }
                path.addLine(to: CGPoint(x: command[1], y: command[2]))
            case 2:
                guard command.count == 5, hasCurrentPoint else { throw BoardFormatError.invalidGeometry }
                path.addQuadCurve(to: CGPoint(x: command[3], y: command[4]), control: CGPoint(x: command[1], y: command[2]))
            case 3:
                guard command.count == 7, hasCurrentPoint else { throw BoardFormatError.invalidGeometry }
                path.addCurve(to: CGPoint(x: command[5], y: command[6]),
                    control1: CGPoint(x: command[1], y: command[2]), control2: CGPoint(x: command[3], y: command[4]))
            case 4:
                guard command.count == 1, hasCurrentPoint else { throw BoardFormatError.invalidGeometry }
                path.closeSubpath()
            default: throw BoardFormatError.invalidGeometry
            }
        }
        // An explicitly empty clip is valid and hides the entire stroke.
        return path
    }
}
