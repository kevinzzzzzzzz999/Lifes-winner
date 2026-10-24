#if canImport(UIKit)
import SwiftUI
import UIKit
import CoreImage

struct ScannedDocumentPage: Identifiable {
    let id: UUID
    let image: UIImage
    var quarterTurns = 0
    var angle: Double = 0
    var crop = CGRect(x: 0, y: 0, width: 1, height: 1)
    var appearance: ScanAppearance = .color
    init(image: UIImage, id: UUID = UUID()) { self.image = image; self.id = id }
}

enum ScanAppearance: String, CaseIterable, Identifiable {
    case color, grayscale, blackWhite
    var id: String { rawValue }
    var title: String {
        switch self {
        case .color: return String(localized: "彩色")
        case .grayscale: return String(localized: "灰度")
        case .blackWhite: return String(localized: "黑白")
        }
    }
}

enum ScanPageRenderer {
    static func boundedCrop(_ rect: CGRect) -> CGRect {
        guard [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }) else { return CGRect(x: 0, y: 0, width: 1, height: 1) }
        let x = min(0.95, max(0, rect.minX)), y = min(0.95, max(0, rect.minY))
        return CGRect(x: x, y: y, width: min(1 - x, max(0.05, rect.width)), height: min(1 - y, max(0.05, rect.height)))
    }
    /// Geometry is kept in the oriented, uncropped page's normalized coordinates.
    /// The original capture is never changed; export renders one page at a time.
    static func render(_ page: ScannedDocumentPage, cropped: Bool = true, maxDimension: CGFloat? = nil) throws -> UIImage {
        let source = page.image
        guard source.size.width > 0, source.size.height > 0 else { throw ScanRenderError.invalidImage }
        let pixelSize = CGSize(width: source.size.width * source.scale, height: source.size.height * source.scale)
        let scale = min(1, (maxDimension ?? max(pixelSize.width, pixelSize.height)) / max(pixelSize.width, pixelSize.height))
        let size = CGSize(width: max(1, (pixelSize.width * scale).rounded()), height: max(1, (pixelSize.height * scale).rounded()))
        let odd = page.quarterTurns % 2 != 0
        let orientedSize = odd ? CGSize(width: size.height, height: size.width) : size
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        var output = UIGraphicsImageRenderer(size: orientedSize, format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: orientedSize))
            context.cgContext.translateBy(x: orientedSize.width / 2, y: orientedSize.height / 2)
            context.cgContext.rotate(by: CGFloat(page.quarterTurns) * .pi / 2 + CGFloat(page.angle) * .pi / 180)
            source.draw(in: CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height))
        }
        if page.appearance != .color {
            guard let input = CIImage(image: output), let controls = CIFilter(name: "CIColorControls") else { throw ScanRenderError.invalidImage }
            controls.setValue(input, forKey: kCIInputImageKey)
            controls.setValue(0, forKey: kCIInputSaturationKey)
            guard var result = controls.outputImage else { throw ScanRenderError.invalidImage }
            if page.appearance == .blackWhite {
                guard let threshold = CIFilter(name: "CIColorThreshold") else { throw ScanRenderError.invalidImage }
                threshold.setValue(result, forKey: kCIInputImageKey)
                threshold.setValue(0.6, forKey: "inputThreshold")
                guard let filtered = threshold.outputImage else { throw ScanRenderError.invalidImage }
                result = filtered
            }
            guard let cg = CIContext(options: [.cacheIntermediates: false]).createCGImage(result, from: input.extent) else { throw ScanRenderError.invalidImage }
            output = UIImage(cgImage: cg)
        }
        if cropped {
            let crop = boundedCrop(page.crop)
            let pixelRect = CGRect(x: crop.minX * output.size.width, y: crop.minY * output.size.height, width: crop.width * output.size.width, height: crop.height * output.size.height).integral
            guard let cg = output.cgImage?.cropping(to: pixelRect) else { throw ScanRenderError.invalidImage }
            output = UIImage(cgImage: cg)
        }
        return output
    }
}

private enum ScanRenderError: LocalizedError {
    case invalidImage
    var errorDescription: String? { String(localized: "无法处理扫描页面，请保留原页并重试。") }
}

struct ScannedPageEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ScannedDocumentPage
    @State private var preview: UIImage?
    @State private var errorMessage: String?
    let onSave: (ScannedDocumentPage) -> Void
    init(page: ScannedDocumentPage, onSave: @escaping (ScannedDocumentPage) -> Void) {
        _draft = State(initialValue: page); self.onSave = onSave
    }
    private var previewID: String { "\(draft.quarterTurns)-\(draft.angle)-\(draft.appearance.rawValue)" }
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                GeometryReader { geometry in
                    if let preview {
                        let factor = min(geometry.size.width / preview.size.width, geometry.size.height / preview.size.height)
                        let size = CGSize(width: preview.size.width * factor, height: preview.size.height * factor)
                        ScanCropCanvas(image: preview, crop: $draft.crop)
                            .frame(width: size.width, height: size.height)
                            .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
                    } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
                }.frame(minHeight: 160).padding(24).background(Color.black.opacity(0.07))
                Text(String(localized: "拖动四角裁剪；扫描相机内还可调整纸张四角以校正透视。"))
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                Picker(String(localized: "扫描颜色"), selection: $draft.appearance) {
                    ForEach(ScanAppearance.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented).padding(.horizontal).accessibilityIdentifier("scanner.page.color")
                HStack {
                    Button(String(localized: "旋转 90°"), systemImage: "rotate.right") {
                        draft.quarterTurns = (draft.quarterTurns + 1) % 4
                        draft.crop = CGRect(x: 0, y: 0, width: 1, height: 1)
                    }.accessibilityIdentifier("scanner.page.rotate")
                    Spacer()
                    Button(String(localized: "还原")) { draft = ScannedDocumentPage(image: draft.image, id: draft.id) }
                }.padding(.horizontal)
                HStack {
                    Text(String(localized: "校正角度"))
                    Slider(value: $draft.angle, in: -15...15, step: 0.5).accessibilityIdentifier("scanner.page.angle")
                    Text(draft.angle.formatted(.number.precision(.fractionLength(1))) + "°").monospacedDigit().frame(width: 56)
                }.padding(.horizontal)
                if let errorMessage { Text(errorMessage).font(.caption).foregroundStyle(.red) }
            }.padding(.bottom)
            .navigationTitle(String(localized: "调整扫描页面"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(String(localized: "取消")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "完成")) { onSave(draft); dismiss() }
                        .disabled(preview == nil || errorMessage != nil).accessibilityIdentifier("scanner.page.done")
                }
            }
            .task(id: previewID) {
                let value = draft
                do {
                    try await Task.sleep(for: .milliseconds(100))
                    let image = try await Task.detached(priority: .userInitiated) { try ScanPageRenderer.render(value, cropped: false, maxDimension: 1200) }.value
                    try Task.checkCancellation()
                    preview = image; errorMessage = nil
                } catch is CancellationError { } catch { errorMessage = error.localizedDescription }
            }
        }
    }
}

private struct ScanCropCanvas: View {
    let image: UIImage
    @Binding var crop: CGRect
    @State private var dragOrigin: CGRect?
    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let rect = CGRect(x: crop.minX * size.width, y: crop.minY * size.height, width: crop.width * size.width, height: crop.height * size.height)
            ZStack(alignment: .topLeading) {
                Image(uiImage: image).resizable().scaledToFit()
                Path { path in
                    path.addRect(CGRect(origin: .zero, size: size)); path.addRect(rect)
                }.fill(.black.opacity(0.45), style: FillStyle(eoFill: true)).allowsHitTesting(false)
                Rectangle().stroke(.yellow, lineWidth: 2).frame(width: rect.width, height: rect.height).offset(x: rect.minX, y: rect.minY).allowsHitTesting(false)
                ForEach(0..<4) { corner in
                    Circle().fill(.white).overlay(Circle().stroke(.yellow, lineWidth: 3)).frame(width: 20, height: 20)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                        .position(x: corner % 2 == 0 ? rect.minX : rect.maxX, y: corner < 2 ? rect.minY : rect.maxY)
                        .accessibilityLabel(String(localized: "裁剪角 \(corner + 1)"))
                        .accessibilityIdentifier("scanner.crop.corner.\(corner)")
                        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                            if dragOrigin == nil { dragOrigin = crop }
                            guard let original = dragOrigin, size.width > 0, size.height > 0 else { return }
                            let dx = value.translation.width / size.width, dy = value.translation.height / size.height
                            var left = original.minX, right = original.maxX, top = original.minY, bottom = original.maxY
                            if corner % 2 == 0 { left = max(0, min(right - 0.05, left + dx)) } else { right = min(1, max(left + 0.05, right + dx)) }
                            if corner < 2 { top = max(0, min(bottom - 0.05, top + dy)) } else { bottom = min(1, max(top + 0.05, bottom + dy)) }
                            crop = CGRect(x: left, y: top, width: right - left, height: bottom - top)
                        }.onEnded { _ in dragOrigin = nil })
                }
            }
        }
    }
}
#endif
