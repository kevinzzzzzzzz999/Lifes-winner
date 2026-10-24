import CoreGraphics

/// Maps displayed crop-box coordinates into the unrotated PDFKit page overlay.
/// The three converted corners include page rotation, crop origin and zoom.
enum PDFWorkspaceOverlayGeometry {
    static func transform(size: CGSize, topLeft: CGPoint, topRight: CGPoint, bottomLeft: CGPoint) -> CGAffineTransform {
        guard size.width > 0, size.height > 0 else { return .identity }
        return CGAffineTransform(a: (topRight.x-topLeft.x)/size.width,
                                 b: (topRight.y-topLeft.y)/size.width,
                                 c: (bottomLeft.x-topLeft.x)/size.height,
                                 d: (bottomLeft.y-topLeft.y)/size.height,
                                 tx: topLeft.x, ty: topLeft.y)
    }
}
