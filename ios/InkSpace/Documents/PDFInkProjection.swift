import Foundation
import CryptoKit
import CoreGraphics
import PDFKit
import PencilKit
import UIKit

struct PDFInkPagePlacement: Sendable {
    let id: UUID
    let sourcePath: String
    let pageNumber: Int
    let x: Double, y: Double, width: Double, height: Double
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

    init?(_ item: BoardItem) {
        guard item.kind == .pdfPage, let source = item.sourcePath, !source.isEmpty,
              let page = item.page, page > 0,
              [item.x, item.y, item.width, item.height].allSatisfy(\.isFinite),
              item.width > 0, item.height > 0 else { return nil }
        id = item.id; sourcePath = source; pageNumber = page
        x = item.x; y = item.y; width = item.width; height = item.height
    }
}

struct PDFInkSpecification {
    let name: String
    let bounds: CGRect
    let paths: [[CGPoint]]
    let width: CGFloat
    let red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat

    func makeAnnotation() -> PDFAnnotation {
        let annotation = PDFAnnotation(bounds: bounds, forType: .ink, withProperties: nil)
        annotation.color = UIColor(red: red, green: green, blue: blue, alpha: alpha)
        let border = PDFBorder(); border.lineWidth = width
        annotation.border = border
        annotation.userName = "InkSpace"
        annotation.contents = PDFAnnotationWritebackService.annotationContents(identifier: name)
        annotation.shouldDisplay = true
        annotation.shouldPrint = true
        annotation.setValue(name, forAnnotationKey: .name)
        for points in paths where !points.isEmpty {
            let path = UIBezierPath()
            path.move(to: points[0])
            if points.count == 1 { path.addLine(to: CGPoint(x: points[0].x + 0.001, y: points[0].y)) }
            else { for point in points.dropFirst() { path.addLine(to: point) } }
            annotation.add(path)
        }
        return annotation
    }
}

enum PDFInkProjection {
    private struct Sample { let point: CGPoint; let width: CGFloat; let opacity: CGFloat }
    private struct Band: Hashable { let width: Int; let opacity: Int }
    private struct ColorComponents { let red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat }
    private static let maximumSampleCount = 2_000_000
    private static let maximumAnnotationCount = 100_000

    static func project(_ drawing: PKDrawing, placements: [PDFInkPagePlacement], in pdf: PDFDocument,
                        boardID: UUID) throws -> [Int: [PDFInkSpecification]] {
        var output: [Int: [PDFInkSpecification]] = [:]
        var sampleCount = 0
        var annotationCount = 0
        for placement in placements {
            guard let page = pdf.page(at: placement.pageNumber - 1) else {
                throw PDFWritebackError.invalidPage(placement.pageNumber)
            }
            let crop = page.bounds(for: .cropBox)
            guard valid(crop), let ref = page.pageRef else { throw PDFWritebackError.invalidGeometry }
            // Core Graphics accounts for /Rotate and crop-box origin. Its output
            // has a bottom-left origin; the final transform makes board Y go down.
            let displayed = CGRect(x: 0, y: 0, width: placement.width, height: placement.height)
            let pdfToDisplay = ref.getDrawingTransform(.cropBox, rect: displayed, rotate: 0, preserveAspectRatio: false)
            // CGPDF can center a smaller page without enlarging it. Normalize its
            // actual transformed crop bounds so the result fills the whole item,
            // matching the board's thumbnail contract at every board scale.
            let transformedCrop = crop.applying(pdfToDisplay).standardized
            guard valid(transformedCrop) else { throw PDFWritebackError.invalidGeometry }
            let scaleX = CGFloat(placement.width) / transformedCrop.width
            let scaleY = CGFloat(placement.height) / transformedCrop.height
            let pdfToWorld = pdfToDisplay.concatenating(CGAffineTransform(
                a: scaleX, b: 0, c: 0, d: -scaleY,
                tx: CGFloat(placement.x) - transformedCrop.minX * scaleX,
                ty: CGFloat(placement.y + placement.height) + transformedCrop.minY * scaleY))
            let worldToPDF = pdfToWorld.inverted()
            guard valid(worldToPDF) else { throw PDFWritebackError.invalidGeometry }
            for (strokeIndex, stroke) in drawing.strokes.enumerated() where stroke.renderBounds.intersects(placement.rect) {
                guard !stroke.path.isEmpty else { continue }
                // This board-only polygon is retained as native ink and portable
                // clip geometry. A PDF Ink annotation's centerline/width cannot
                // represent its mask; never write an unclipped broad strip into
                // the source PDF. Ordinary masked/erased ink keeps its old path.
                guard !BoardWritingAidStrokes.isTaggedFill(stroke) else { continue }
                let color = try components(stroke.ink.color)
                let combined = stroke.transform.concatenating(worldToPDF)
                let widthScale = sqrt(abs(combined.a * combined.d - combined.b * combined.c))
                guard widthScale.isFinite, widthScale > 0 else { throw PDFWritebackError.invalidGeometry }
                let ranges: [ClosedRange<CGFloat>]
                if stroke.mask == nil { ranges = [0...CGFloat(stroke.path.count - 1)] }
                else { ranges = stroke.maskedPathRanges }
                var sampledRanges: [[Sample]] = []
                for range in ranges {
                    var samples: [Sample] = []
                    for point in stroke.path.interpolatedPoints(in: range, by: .distance(1.5)) {
                        sampleCount += 1
                        guard sampleCount <= maximumSampleCount else { throw PDFWritebackError.tooComplex }
                        let world = point.location.applying(stroke.transform)
                        let width = max(0.1, (point.size.width + point.size.height) * 0.5 * widthScale)
                        guard world.x.isFinite, world.y.isFinite, width.isFinite, point.opacity.isFinite else {
                            throw PDFWritebackError.invalidGeometry
                        }
                        samples.append(Sample(point: world, width: width, opacity: min(1, max(0, point.opacity))))
                    }
                    if !samples.isEmpty { sampledRanges.append(samples) }
                }
                let allSamples = sampledRanges.flatMap { $0 }
                guard !allSamples.isEmpty else { continue }
                let meanWidth = allSamples.reduce(CGFloat.zero) { $0 + $1.width } / CGFloat(allSamples.count)
                var bands: [Band: [[CGPoint]]] = [:]
                for samples in sampledRanges {
                    if samples.count == 1, placement.rect.contains(samples[0].point) {
                        let sample = samples[0]
                        let p = annotationPoint(sample.point, transform: worldToPDF, crop: crop)
                        let band = bandFor(width: sample.width, opacity: sample.opacity, meanWidth: meanWidth)
                        bands[band, default: []].append([p, CGPoint(x: p.x + 0.001, y: p.y)])
                    }
                    var currentBand: Band?
                    var currentPath: [CGPoint] = []
                    func finish() {
                        if let currentBand, currentPath.count > 1 { bands[currentBand, default: []].append(currentPath) }
                        currentPath = []; currentBand = nil
                    }
                    for index in 1..<max(1, samples.count) {
                        let first = samples[index - 1], second = samples[index]
                        guard let segment = clip(first.point, second.point, to: placement.rect) else { finish(); continue }
                        let band = bandFor(width: (first.width + second.width) * 0.5,
                                           opacity: (first.opacity + second.opacity) * 0.5, meanWidth: meanWidth)
                        let a = annotationPoint(segment.0, transform: worldToPDF, crop: crop)
                        let b = annotationPoint(segment.1, transform: worldToPDF, crop: crop)
                        if currentBand != band || currentPath.last.map({ distance($0, a) > 0.01 }) == true { finish() }
                        if currentPath.isEmpty { currentBand = band; currentPath = [a] }
                        currentPath.append(b)
                        if distance(segment.1, second.point) > 0.01 { finish() }
                    }
                    finish()
                }
                for band in bands.keys.sorted(by: { ($0.width, $0.opacity) < ($1.width, $1.opacity) }) {
                    guard let paths = bands[band], !paths.isEmpty, band.opacity > 0, color.alpha > 0 else { continue }
                    let widthFactor: CGFloat = band.width == 0 ? 0.6 : (band.width == 2 ? 1.6 : 1)
                    let width = max(0.1, meanWidth * widthFactor)
                    let alpha = color.alpha * CGFloat(band.opacity) / 10
                    let digest = fingerprint(placement: placement.id, stroke: strokeIndex, bounds: crop,
                                             paths: paths, width: width, color: color, alpha: alpha)
                    let spec = PDFInkSpecification(name: PDFAnnotationWritebackService.ownerPrefix(boardID: boardID) + digest,
                                                   bounds: crop, paths: paths, width: width,
                                                   red: color.red, green: color.green, blue: color.blue, alpha: alpha)
                    output[placement.pageNumber - 1, default: []].append(spec)
                    annotationCount += 1
                    guard annotationCount <= maximumAnnotationCount else { throw PDFWritebackError.tooComplex }
                }
            }
        }
        return output
    }

    static func matches(_ annotations: [PDFAnnotation], specifications: [PDFInkSpecification]) -> Bool {
        guard annotations.count == specifications.count else { return false }
        var byName: [String: PDFAnnotation] = [:]
        for annotation in annotations {
            guard let name = PDFAnnotationWritebackService.annotationIdentifier(annotation), byName[name] == nil else { return false }
            byName[name] = annotation
        }
        for spec in specifications {
            guard let annotation = byName[spec.name], annotation.type == "Ink",
                  near(annotation.bounds.origin, spec.bounds.origin),
                  near(CGPoint(x: annotation.bounds.width, y: annotation.bounds.height), CGPoint(x: spec.bounds.width, y: spec.bounds.height)),
                  abs((annotation.border?.lineWidth ?? 0) - spec.width) < 0.01,
                  let color = try? components(annotation.color),
                  abs(color.red - spec.red) < 0.01, abs(color.green - spec.green) < 0.01,
                  abs(color.blue - spec.blue) < 0.01,
                  let paths = annotation.paths, paths.count == spec.paths.count else { return false }
            for (path, expected) in zip(paths, spec.paths) {
                var points: [CGPoint] = []
                var unsupported = false
                path.cgPath.applyWithBlock { element in
                    switch element.pointee.type {
                    case .moveToPoint, .addLineToPoint: points.append(element.pointee.points[0])
                    default: unsupported = true
                    }
                }
                guard !unsupported, points.count == expected.count, zip(points, expected).allSatisfy({ near($0, $1) }) else { return false }
            }
            if annotation.hasAppearanceStream {
                // PDFKit may report opaque /C after reopening while the actual
                // alpha lives in AP graphics state (CA/ca). Verify the rendered
                // appearance, not the lossy color getter or a self-reported tag.
                guard matchesAppearance(annotation, specification: spec) else { return false }
            } else if abs(color.alpha - spec.alpha) >= 0.01 { return false }
        }
        return true
    }

    private static func matchesAppearance(_ annotation: PDFAnnotation, specification: PDFInkSpecification) -> Bool {
        let points = specification.paths.flatMap { $0 }
        guard let first = points.first else { return false }
        var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
        for point in points {
            minX = min(minX, point.x); maxX = max(maxX, point.x)
            minY = min(minY, point.y); maxY = max(maxY, point.y)
        }
        let padding = max(2, specification.width * 2)
        var rect = CGRect(x: specification.bounds.minX + minX - padding,
                          y: specification.bounds.minY + minY - padding,
                          width: maxX - minX + 2 * padding, height: maxY - minY + 2 * padding)
        // PDFAnnotation.draw uses its owning page's crop origin and rotation.
        // Match that environment without inserting the reference into the real PDF.
        let reference = specification.makeAnnotation()
        var shadowPage: PDFPage?
        if let page = annotation.page {
            let media = page.bounds(for: .mediaBox), crop = page.bounds(for: .cropBox)
            let transform = page.transform(for: .cropBox)
            guard valid(media), valid(crop), valid(transform) else { return false }
            let shadow = PDFPage()
            shadow.setBounds(media, for: .mediaBox)
            shadow.setBounds(crop, for: .cropBox)
            shadow.rotation = page.rotation
            shadow.addAnnotation(reference)
            shadowPage = shadow
            rect = rect.applying(transform).standardized
        }
        guard valid(rect) else { return false }
        let scale = min(2, 256 / max(rect.width, rect.height))
        let width = max(32, min(256, Int(ceil(rect.width * scale))))
        let height = max(32, min(256, Int(ceil(rect.height * scale))))
        func render(_ value: PDFAnnotation) -> [UInt8]? {
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            let drew = bytes.withUnsafeMutableBytes { buffer -> Bool in
                guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                      let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                          bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
                context.scaleBy(x: CGFloat(width) / rect.width, y: CGFloat(height) / rect.height)
                context.translateBy(x: -rect.minX, y: -rect.minY)
                value.draw(with: .cropBox, in: context)
                return true
            }
            return drew ? bytes : nil
        }
        // PDFAnnotation.page is weak, so retain the shadow until drawing finishes.
        let expectedPixels = withExtendedLifetime(shadowPage) { render(reference) }
        guard let expected = expectedPixels, let actual = render(annotation),
              stride(from: 3, to: expected.count, by: 4).contains(where: { expected[$0] >= 8 }) else { return false }
        // Permit only small raster rounding differences. Invisible/too-fine ink
        // is not evidence of matching alpha and is deliberately rejected above.
        return zip(actual, expected).allSatisfy { abs(Int($0) - Int($1)) <= 3 }
    }

    private static func bandFor(width: CGFloat, opacity: CGFloat, meanWidth: CGFloat) -> Band {
        let ratio = width / max(0.1, meanWidth)
        return Band(width: ratio < 0.8 ? 0 : (ratio > 1.3 ? 2 : 1), opacity: Int((opacity * 10).rounded()))
    }
    private static func annotationPoint(_ world: CGPoint, transform: CGAffineTransform, crop: CGRect) -> CGPoint {
        let pagePoint = world.applying(transform)
        return CGPoint(x: pagePoint.x - crop.minX, y: pagePoint.y - crop.minY)
    }
    private static func components(_ color: UIColor) throws -> ColorComponents {
        let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let converted = resolved.cgColor.converted(to: space, intent: .defaultIntent, options: nil),
              let values = converted.components, values.count >= 3 else { throw PDFWritebackError.invalidGeometry }
        return ColorComponents(red: values[0], green: values[1], blue: values[2], alpha: converted.alpha)
    }
    private static func fingerprint(placement: UUID, stroke: Int, bounds: CGRect, paths: [[CGPoint]],
                                    width: CGFloat, color: ColorComponents, alpha: CGFloat) -> String {
        var text = "\(placement.uuidString):\(stroke):"
        func add(_ value: CGFloat) { text += String(format: "%.5f,", locale: Locale(identifier: "en_US_POSIX"), Double(value)) }
        [bounds.minX, bounds.minY, bounds.width, bounds.height, width, color.red, color.green, color.blue, alpha].forEach(add)
        for path in paths { text += ";"; for point in path { add(point.x); add(point.y) } }
        return SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private static func near(_ a: CGPoint, _ b: CGPoint) -> Bool { distance(a, b) < 0.01 }
    private static func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }
    private static func valid(_ rect: CGRect) -> Bool {
        [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite) && rect.width > 0 && rect.height > 0
    }
    private static func valid(_ transform: CGAffineTransform) -> Bool {
        [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy(\.isFinite)
            && abs(transform.a * transform.d - transform.b * transform.c) > 1e-15
    }
    /// Liang-Barsky clips every segment, preserving separate paths across page gaps.
    private static func clip(_ a: CGPoint, _ b: CGPoint, to rect: CGRect) -> (CGPoint, CGPoint)? {
        let dx = b.x - a.x, dy = b.y - a.y
        var start: CGFloat = 0, end: CGFloat = 1
        for (p, q) in [(-dx, a.x - rect.minX), (dx, rect.maxX - a.x), (-dy, a.y - rect.minY), (dy, rect.maxY - a.y)] {
            if abs(p) < 1e-12 { if q < 0 { return nil }; continue }
            let ratio = q / p
            if p < 0 { start = max(start, ratio) } else { end = min(end, ratio) }
            if start > end { return nil }
        }
        return (CGPoint(x: a.x + start * dx, y: a.y + start * dy), CGPoint(x: a.x + end * dx, y: a.y + end * dy))
    }
}
