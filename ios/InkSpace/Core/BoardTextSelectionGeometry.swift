import Foundation
import CoreGraphics

/// Identity of the pixels passed to on-device text analysis. Screen dimensions,
/// world offset and scale are all required: the same text at a different zoom
/// cannot reuse its previous selection geometry.
struct BoardTextSelectionSnapshotKey: Equatable {
    let sessionID: UUID
    let boardID: UUID
    let size: CGSize
    let offset: CGPoint
    let zoom: CGFloat
    let documentRevision: Int
    let updatedAt: Date
    let previewEpoch: Int
    let imageRevision: Int
    let renderedRevision: Int
    /// Native ink changes independently of the document's saved metadata.
    /// A default keeps the existing PDF/video/document consumers compatible.
    var nativeInkRevision: UInt64 = 0
    /// Explicit in-content recognition may spend more pixels; ordinary reading
    /// retains its smaller idle-analysis budget and never changes ink rendering.
    var prefersHighResolution = false

    var isValid: Bool {
        size.width.isFinite && size.height.isFinite && size.width >= 8 && size.height >= 8
            && offset.x.isFinite && offset.y.isFinite && zoom.isFinite && zoom > 0
    }

    func worldPoint(for screenPoint: CGPoint) -> CGPoint {
        CGPoint(x: (screenPoint.x + offset.x) / zoom, y: (screenPoint.y + offset.y) / zoom)
    }

    func worldRect(forNormalizedRect rect: CGRect) -> CGRect {
        CGRect(origin: worldPoint(for: CGPoint(x: rect.minX * size.width, y: rect.minY * size.height)),
            size: CGSize(width: rect.width * size.width / zoom, height: rect.height * size.height / zoom))
    }

    func normalizedRect(forWorldRect rect: CGRect) -> CGRect {
        CGRect(x: (rect.minX * zoom - offset.x) / size.width, y: (rect.minY * zoom - offset.y) / size.height,
            width: rect.width * zoom / size.width, height: rect.height * zoom / size.height)
    }

    /// Speech keeps an immutable transcript. Preview resolution/cache changes
    /// cannot invalidate its world geometry; an actual document edit can.
    func hasSameDocument(as other: Self) -> Bool {
        sessionID == other.sessionID && boardID == other.boardID && documentRevision == other.documentRevision
            && nativeInkRevision == other.nativeInkRevision
    }

    func hasSameContent(as other: Self) -> Bool {
        sessionID == other.sessionID && boardID == other.boardID && documentRevision == other.documentRevision
            && updatedAt == other.updatedAt && previewEpoch == other.previewEpoch
            && imageRevision == other.imageRevision && renderedRevision == other.renderedRevision
            && nativeInkRevision == other.nativeInkRevision
    }

    /// VisionKit uses top-left unit coordinates within the custom content view.
    /// The viewport snapshot fills that view, so no crop or world origin is
    /// applied to the native selection a second time.
    var contentsRect: CGRect { CGRect(x: 0, y: 0, width: 1, height: 1) }

    var renderScale: CGFloat {
        guard isValid else { return 0 }
        let dimension: CGFloat = prefersHighResolution ? 4096 : 2600
        let pixels: CGFloat = prefersHighResolution ? 12_000_000 : 6_000_000
        let scale = min(prefersHighResolution ? 3 : 2, dimension / max(size.width, size.height),
                        sqrt(pixels / size.width / size.height))
        // UIKit rounds bitmap dimensions up. Quantize down first so a viewport
        // near the pixel limit cannot exceed it by a row and be rejected.
        let rounded = min(floor(size.width * scale) / size.width, floor(size.height * scale) / size.height)
        return rounded > 0 ? rounded.nextDown : 0
    }
}

/// A completed analysis may be installed exactly once, only for the currently
/// requested pixels. Kept independent of UIKit/VisionKit for race tests.
struct BoardTextSelectionGeneration {
    private(set) var value: UInt64 = 0
    private(set) var key: BoardTextSelectionSnapshotKey?
    @discardableResult mutating func replace(with next: BoardTextSelectionSnapshotKey?) -> Bool {
        guard key != next else { return false }
        value &+= 1
        key = next
        return true
    }
    mutating func invalidate() { value &+= 1; key = nil }
    func accepts(_ generation: UInt64, key candidate: BoardTextSelectionSnapshotKey) -> Bool {
        generation == value && key == candidate && candidate.isValid
    }
}

/// Keep engine-supported identifiers, including Chinese scripts, instead of
/// failing recognition when one hard-coded language is unavailable.
enum BoardTextRecognitionPolicy {
    static func languages(supported: [String], preferred: [String] = Locale.preferredLanguages) -> [String] {
        func normalized(_ value: String) -> String { value.replacingOccurrences(of: "_", with: "-").lowercased() }
        var result: [String] = []
        for desired in ["zh-Hans", "zh-Hant", "en-US"] + preferred {
            let target = normalized(desired)
            let scriptTarget = target.hasPrefix("zh-tw") || target.hasPrefix("zh-hk") || target.hasPrefix("zh-mo") ? "zh-hant" :
                target.hasPrefix("zh-cn") || target.hasPrefix("zh-sg") ? "zh-hans" : target
            let match = supported.first { normalized($0) == scriptTarget }
                ?? supported.first { normalized($0).hasPrefix(scriptTarget + "-") }
                ?? (scriptTarget.hasPrefix("zh-") ? nil : supported.first {
                    normalized($0).split(separator: "-").first == scriptTarget.split(separator: "-").first
                })
            if let match, !result.contains(match) { result.append(match) }
            if result.count == 6 { break }
        }
        // An empty locales list lets VisionKit use the device language defaults.
        return result
    }
}
