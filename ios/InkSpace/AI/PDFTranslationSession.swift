import SwiftUI
import PDFKit
import UIKit

@MainActor @Observable final class PDFTranslationSession {
    let capture = TemporaryBoardCapture(copyPNG: { _ in })
    private(set) var cardID: UUID?
    private(set) var text = ""
    private(set) var error = ""
    private(set) var isLoading = false
    private(set) var requestDescription = ""
    var isPinned = false
    var cardOrigin = CGPoint(x: 20, y: 100)
    var cardSize = CGSize(width: 340, height: 300)
    var showsSettings = false
    @ObservationIgnored var onSettingsChanged: (() -> Void)?
    @ObservationIgnored private var request: Task<Void, Never>?
    @ObservationIgnored private var requestID: UUID?
    @ObservationIgnored private var png: Data?
    @ObservationIgnored private let client: PDFTranslationClient
    @ObservationIgnored private let readKey: (PDFTranslationProvider) throws -> String
    @ObservationIgnored private let defaults: UserDefaults
    init(client: PDFTranslationClient = PDFTranslationClient(), defaults: UserDefaults = .standard,
         readKey: @escaping (PDFTranslationProvider) throws -> String = { try PDFTranslationKeyStore.read($0) }) {
        self.client = client; self.defaults = defaults; self.readKey = readKey
    }
    var provider: PDFTranslationProvider { PDFTranslationProvider.selected(in: defaults) }
    var model: String { provider.model(in: defaults) }
    var language: String { defaults.string(forKey: "PDFTranslation.language") ?? "简体中文" }
    func begin(source: any TemporaryCanvasSnapshotSource) {
        close(); capture.source = source
        _ = capture.begin(sessionID: source.snapshotSessionID)
    }
    func selected(_ rect: CGRect, availableSize: CGSize) {
        capture.finish(rect: rect)
        guard let image = capture.image else { return }
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return }
        let scale = min(1, 1600 / longest), size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let bounded = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size)); image.draw(in: CGRect(origin: .zero, size: size))
        }
        png = bounded.pngData(); cardID = UUID(); text = ""; error = ""; isPinned = false
        cardOrigin = CGPoint(x: rect.maxX + 12, y: rect.minY)
        clamp(to: availableSize); translate()
    }
    func translate() {
        guard let id = cardID, let png else { return }
        request?.cancel(); let token = UUID(); requestID = token; isLoading = true; error = ""; text = ""
        let model = model, language = language, provider = provider
        requestDescription = provider.title + " · " + model
        request = Task { [weak self] in
            guard let self else { return }
            do {
                let key = try readKey(provider)
                let result = try await client.translate(png: png, provider: provider, model: model, language: language, apiKey: key)
                guard !Task.isCancelled, cardID == id, requestID == token else { return }
                text = result; isLoading = false; request = nil
            } catch is CancellationError {
                if cardID == id, requestID == token { isLoading = false }
            } catch {
                guard !Task.isCancelled, cardID == id, requestID == token else { return }
                self.error = error.localizedDescription; isLoading = false; request = nil
            }
        }
    }
    func close() {
        request?.cancel(); request = nil; requestID = nil; cardID = nil; png = nil
        text = ""; error = ""; requestDescription = ""; isLoading = false; isPinned = false; capture.clear()
    }
    func cancelRequest() { request?.cancel(); request = nil; requestID = nil; isLoading = false }
    func settingsChanged() { cancelRequest(); text = ""; error = ""; requestDescription = ""; onSettingsChanged?() }
    func clamp(to bounds: CGSize) {
        cardSize.width = min(max(240, cardSize.width), max(240, min(620, bounds.width - 16)))
        cardSize.height = min(max(180, cardSize.height), max(180, bounds.height - 16))
        cardOrigin.x = min(max(8, cardOrigin.x), max(8, bounds.width - cardSize.width - 8))
        cardOrigin.y = min(max(8, cardOrigin.y), max(8, bounds.height - cardSize.height - 8))
    }
}

/// Uses only one displayed PDF page, including the user's visible annotations.
@MainActor final class BoardPDFTranslationSource: TemporaryCanvasSnapshotSource {
    weak var store: BoardStore?
    weak var host: BoardCanvasHost?
    init(store: BoardStore, host: BoardCanvasHost) { self.store = store; self.host = host }
    var snapshotSessionID: UUID { host?.snapshotSessionID ?? UUID() }
    var snapshotBounds: CGRect { host?.snapshotBounds ?? .zero }
    var snapshotInteractionActive: Bool { host?.snapshotInteractionActive != false || store?.isPadReading != true || store?.isBusy != false }
    func temporarySnapshot(in rect: CGRect) -> UIImage? {
        guard let store, let host, !snapshotInteractionActive, store.canvasSessionID == host.snapshotSessionID else { return nil }
        let zoom = host.canvas.zoomScale, offset = host.canvas.contentOffset
        let world = CGRect(x: (rect.minX + offset.x) / zoom, y: (rect.minY + offset.y) / zoom, width: rect.width / zoom, height: rect.height / zoom)
        guard let item = store.document.items.last(where: { $0.kind == .pdfPage && $0.rect.insetBy(dx: -0.1, dy: -0.1).contains(world) }),
              host.hasTranslationPreview(for: item.id) else { return nil }
        return host.temporarySnapshot(in: rect)
    }
}

@MainActor final class PDFReaderTranslationSource: TemporaryCanvasSnapshotSource {
    weak var view: PDFView?
    var snapshotSessionID = UUID()
    var snapshotBounds: CGRect { view?.bounds ?? .zero }
    var snapshotInteractionActive: Bool {
        guard let view, view.document != nil else { return true }
        func active(_ current: UIView) -> Bool {
            if let scroll = current as? UIScrollView, scroll.isTracking || scroll.isDragging || scroll.isDecelerating || scroll.isZooming { return true }
            return current.subviews.contains(where: active)
        }
        return active(view)
    }
    func temporarySnapshot(in rect: CGRect) -> UIImage? {
        guard let view, view.window != nil, !snapshotInteractionActive, view.bounds.contains(rect), rect.width >= 8, rect.height >= 8,
              let page = view.page(for: CGPoint(x: rect.midX, y: rect.midY), nearest: false),
              view.convert(page.bounds(for: view.displayBox), from: page).contains(rect) else { return nil }
        let format = UIGraphicsImageRendererFormat(); format.scale = min(2, 1600 / max(rect.width, rect.height)); format.opaque = true
        return UIGraphicsImageRenderer(size: rect.size, format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: rect.size))
            context.cgContext.translateBy(x: -rect.minX, y: -rect.minY)
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
        }
    }
}
