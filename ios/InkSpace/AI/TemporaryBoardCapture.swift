import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Read-only surface contract. Implementations must not change board or ink state.
@MainActor protocol TemporaryCanvasSnapshotSource: AnyObject {
    var snapshotSessionID: UUID { get }
    var snapshotBounds: CGRect { get }
    var snapshotInteractionActive: Bool { get }
    func temporarySnapshot(in rect: CGRect) -> UIImage?
}

@MainActor @Observable final class TemporaryBoardCapture {
    @ObservationIgnored weak var source: (any TemporaryCanvasSnapshotSource)?
    private(set) var image: UIImage?
    private(set) var isSelecting = false
    private(set) var status = ""
    var prompt = ""
    @ObservationIgnored private var expectedSession: UUID?
    @ObservationIgnored private let copyPNG: (Data) -> Void

    init(copyPNG: @escaping (Data) -> Void = { png in
        UIPasteboard.general.setItems([[UTType.png.identifier: png]], options: [
            .localOnly: true, .expirationDate: Date().addingTimeInterval(10 * 60)
        ])
    }) { self.copyPNG = copyPNG }

    @discardableResult
    func begin(sessionID: UUID) -> Bool {
        guard let source, source.snapshotSessionID == sessionID else {
            cancel(); status = String(localized: "白板已切换，请重新框选截图。"); return false
        }
        guard !source.snapshotInteractionActive else { rejectActiveInteraction(); return false }
        expectedSession = sessionID
        status = ""
        isSelecting = true
        return true
    }
    /// Called while the overlay is active as well as before publication. A second
    /// touch already owned by the canvas must finish before capture can continue.
    @discardableResult
    func continueSelection() -> Bool {
        guard isSelecting else { return false }
        guard let source, source.snapshotSessionID == expectedSession else {
            cancel(); status = String(localized: "白板已切换，请重新框选截图。"); return false
        }
        guard !source.snapshotInteractionActive else { rejectActiveInteraction(); return false }
        return true
    }
    func rejectActiveInteraction() {
        cancel()
        status = String(localized: "请先结束当前笔触、拖动或缩放，再框选截图。")
    }
    func cancel() { isSelecting = false; expectedSession = nil }
    func clear() { cancel(); image = nil; prompt = ""; status = "" }
    func discardImage() { image = nil; status = "" }
    func finish(rect: CGRect) {
        defer { cancel() }
        guard continueSelection() else { return }
        guard let source, source.snapshotSessionID == expectedSession else {
            status = String(localized: "白板已切换，请重新框选截图。")
            return
        }
        let crop = rect.standardized.intersection(source.snapshotBounds)
        guard !crop.isNull, crop.width >= 8, crop.height >= 8,
              let result = source.temporarySnapshot(in: crop) else {
            status = String(localized: "未能生成选区截图，请在可见白板内重新框选。")
            return
        }
        image = result
        status = String(localized: "选区已准备好，尚未发送。先复制图片并在 AI 网页输入框粘贴，确认附件出现后再粘贴问题。")
    }
    /// This method is called only by the explicit Copy button. Capture/close never
    /// reads or writes the clipboard, saves a file, or sends content to the web.
    @discardableResult func copyImage() -> Bool {
        guard let image, let png = image.pngData() else {
            status = String(localized: "截图无法转换，请重新框选。"); return false
        }
        guard png.count <= 16 * 1_024 * 1_024 else {
            status = String(localized: "截图超过 16 MB，请缩小选区后重试。"); return false
        }
        copyPNG(png)
        status = String(localized: "已复制截图。请点网页输入框，长按选择“粘贴”；确认图片出现后，由你发送。")
        return true
    }
    func copyPrompt() {
        let value = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: value]], options: [
            .localOnly: true, .expirationDate: Date().addingTimeInterval(10 * 60)
        ])
        status = String(localized: "已复制问题，尚未发送。请在 AI 网页输入框粘贴，核对图片和文字后再发送。")
    }
}

struct TemporaryBoardCaptureOverlay: View {
    let capture: TemporaryBoardCapture
    let onFinish: () -> Void
    @State private var start: CGPoint?
    @State private var end: CGPoint?
    @State private var adjustmentOrigin: CGRect?
    private var selection: CGRect? {
        guard let start, let end else { return nil }
        return CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
                      width: abs(start.x - end.x), height: abs(start.y - end.y))
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .top) {
                Color.black.opacity(0.04).contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 2, coordinateSpace: .named("chatCapture"))
                        .onChanged { value in
                            guard capture.continueSelection() else { reset(); return }
                            start = clamped(value.startLocation, to: geometry.size)
                            end = clamped(value.location, to: geometry.size)
                        }
                        .onEnded { value in
                            guard capture.continueSelection() else { reset(); return }
                            end = clamped(value.location, to: geometry.size)
                        })
                    .accessibilityIdentifier("chatgpt.capture.surface")
                if let selection {
                    Rectangle().fill(.teal.opacity(0.1))
                        .overlay(Rectangle().strokeBorder(.teal, style: StrokeStyle(lineWidth: 2, dash: [7, 4])))
                        .frame(width: selection.width, height: selection.height)
                        .contentShape(Rectangle())
                        .position(x: selection.midX, y: selection.midY)
                        .gesture(DragGesture(coordinateSpace: .named("chatCapture"))
                            .onChanged { value in
                                guard capture.continueSelection() else { reset(); return }
                                if adjustmentOrigin == nil { adjustmentOrigin = selection }
                                guard let original = adjustmentOrigin else { return }
                                let x = min(max(0, original.minX + value.translation.width), max(0, geometry.size.width - original.width))
                                let y = min(max(0, original.minY + value.translation.height), max(0, geometry.size.height - original.height))
                                start = CGPoint(x: x, y: y)
                                end = CGPoint(x: x + original.width, y: y + original.height)
                            }
                            .onEnded { _ in adjustmentOrigin = nil })
                    ForEach(0..<4) { corner in
                        resizeHandle(corner, selection: selection, size: geometry.size)
                    }
                }
                VStack(spacing: 8) {
                    Text(selection == nil ? String(localized: "拖出矩形选区") : String(localized: "拖动选区移动，拖动四角调整大小"))
                        .font(.callout)
                    HStack(spacing: 14) {
                        Button(String(localized: "取消")) { capture.cancel(); onFinish() }
                            .accessibilityIdentifier("chatgpt.capture.cancel")
                        if selection != nil {
                            Button(String(localized: "重新框选")) { reset() }
                                .accessibilityIdentifier("chatgpt.capture.redraw")
                            Button(String(localized: "使用选区")) {
                                if let selection { capture.finish(rect: selection) }
                                reset(); onFinish()
                            }.buttonStyle(.borderedProminent)
                                .disabled((selection?.width ?? 0) < 8 || (selection?.height ?? 0) < 8)
                                .accessibilityIdentifier("chatgpt.capture.confirm")
                        }
                    }
                }
                .padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)).padding(12)
            }
            .coordinateSpace(name: "chatCapture")
            .onChange(of: geometry.size) { _, size in
                if let start { self.start = clamped(start, to: size) }
                if let end { self.end = clamped(end, to: size) }
                adjustmentOrigin = nil
            }
        }
    }
    private func resizeHandle(_ corner: Int, selection: CGRect, size: CGSize) -> some View {
        let left = corner == 0 || corner == 2
        let top = corner < 2
        let point = CGPoint(x: left ? selection.minX : selection.maxX, y: top ? selection.minY : selection.maxY)
        return Circle().fill(.white).overlay(Circle().strokeBorder(.teal, lineWidth: 2))
            .frame(width: 14, height: 14).frame(width: 44, height: 44).contentShape(Rectangle())
            .position(point)
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("chatCapture"))
                .onChanged { value in
                    guard capture.continueSelection() else { reset(); return }
                    if adjustmentOrigin == nil { adjustmentOrigin = selection }
                    guard let original = adjustmentOrigin else { return }
                    let fixed = CGPoint(x: left ? original.maxX : original.minX, y: top ? original.maxY : original.minY)
                    start = fixed; end = clamped(value.location, to: size)
                }
                .onEnded { _ in adjustmentOrigin = nil })
            .accessibilityLabel(String(localized: "调整选区角点"))
    }
    private func reset() { start = nil; end = nil; adjustmentOrigin = nil }
    private func clamped(_ point: CGPoint, to size: CGSize) -> CGPoint {
        CGPoint(x: min(size.width, max(0, point.x)), y: min(size.height, max(0, point.y)))
    }
}
