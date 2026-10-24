import Foundation
import PencilKit
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// The opaque PencilKit payload is bounded before decoding and checked again
/// afterwards. Failure leaves the original archive and legacy points intact.
enum PDFNativeInk {
    static func archive(_ drawing: PKDrawing, referenceWidth: CGFloat) -> PDFNativeInkArchive? {
        guard referenceWidth.isFinite, referenceWidth >= 1, referenceWidth <= 100_000,
              valid(drawing, referenceWidth: referenceWidth) else { return nil }
        let data = drawing.dataRepresentation()
        let value = PDFNativeInkArchive(referenceWidth: Double(referenceWidth), data: data)
        return value.isValid ? value : nil
    }
    static func drawing(_ archive: PDFNativeInkArchive, width: CGFloat) -> PKDrawing? {
        guard archive.isValid, width.isFinite, width > 0, width <= 100_000,
              let value = try? PKDrawing(data: archive.data), valid(value, referenceWidth: archive.referenceWidth) else { return nil }
        let scale = width / archive.referenceWidth
        return scale == 1 ? value : value.transformed(using: CGAffineTransform(scaleX: scale, y: scale))
    }
    private static func valid(_ drawing: PKDrawing, referenceWidth: CGFloat) -> Bool {
        guard !drawing.strokes.isEmpty, drawing.strokes.count <= 500 else { return false }
        var count = 0
        for stroke in drawing.strokes {
            count += stroke.path.count
            let t = stroke.transform
            guard stroke.path.count > 0, count <= 100_000,
                  [t.a,t.b,t.c,t.d,t.tx,t.ty].allSatisfy(\.isFinite),
                  abs(t.a*t.d-t.b*t.c) > 0.00000001 else { return false }
            for p in stroke.path {
                let location = p.location.applying(t)
                guard location.x.isFinite, location.y.isFinite,
                      abs(location.x) <= referenceWidth * 32, abs(location.y) <= referenceWidth * 32,
                      [p.size.width,p.size.height,p.opacity,p.force,p.azimuth,p.altitude].allSatisfy(\.isFinite),
                      p.size.width >= 0, p.size.height >= 0, p.size.width <= referenceWidth * 2,
                      p.size.height <= referenceWidth * 2, p.timeOffset.isFinite else { return false }
            }
        }
        let bounds=drawing.bounds
        return [bounds.minX,bounds.minY,bounds.maxX,bounds.maxY].allSatisfy{$0.isFinite && abs($0)<=referenceWidth*36}
    }

    /// Export and replay use PencilKit's pigment renderer, retaining textured
    /// brushes and variable pressure. Only the visible stroke crop is rasterized.
    @discardableResult static func paint(_ archive: PDFNativeInkArchive?, width: CGFloat,
                                        origin: CGPoint = .zero, context: CGContext) -> Bool {
        guard let archive, let drawing = drawing(archive, width: width) else { return false }
        let clip = context.boundingBoxOfClipPath.offsetBy(dx: -origin.x, dy: -origin.y)
        let crop = drawing.bounds.intersection(clip).integral
        guard !crop.isNull, !crop.isEmpty, crop.width.isFinite, crop.height.isFinite else { return true }
        let scale = min(3, 4096 / max(crop.width, crop.height))
        guard scale.isFinite, scale > 0 else { return false }
        let image = drawing.image(from: crop, scale: scale)
        #if canImport(UIKit)
        UIGraphicsPushContext(context)
        image.draw(in: crop.offsetBy(dx: origin.x, dy: origin.y))
        UIGraphicsPopContext()
        #elseif canImport(AppKit)
        var proposed=CGRect(origin:.zero,size:image.size)
        guard let cg=image.cgImage(forProposedRect:&proposed,context:nil,hints:nil) else{return false}
        let target=crop.offsetBy(dx:origin.x,dy:origin.y)
        context.saveGState();context.translateBy(x:target.minX,y:target.maxY);context.scaleBy(x:1,y:-1)
        context.draw(cg,in:CGRect(origin:.zero,size:target.size));context.restoreGState()
        #endif
        return true
    }
}
