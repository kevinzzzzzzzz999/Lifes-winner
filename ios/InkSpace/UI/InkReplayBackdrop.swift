import UIKit

/// Viewport-sized background with strictly bounded bitmap work. A 2,000-page
/// board creates neither a giant image nor 2,000 concurrent source-file reads.
@MainActor
final class InkReplayBackdrop: UIView {
    private struct Key: Hashable { let id: UUID; let length: Int; var tile: [Double]? = nil }
    private struct Cached { let image: UIImage; let cost: Int; var tick: Int; var rect: CGRect? = nil }
    private struct Job { let item: BoardItem; let key: Key; var region: BoardPDFTileRegion? = nil; var rect: CGRect? = nil }
    private let items: [BoardItem]
    private var library: DocumentLibrary?
    private var viewport = CGRect.zero
    private var zoom: CGFloat = 1
    private var visible: [BoardItem] = []
    private var desired: [Job] = []
    private var cached: [Key: Cached] = [:]
    private var flights: [Key: BoardPreviewCancellation] = [:]
    private var failed: Set<UUID> = []
    private var tick = 0
    private var bytes = 0
    private var released = false
    private var visibleTotal = 0
    private(set) var status = ""
    var onStatus: ((String) -> Void)?
    private let budget = 16 * 1_024 * 1_024
    var metrics: (inFlight: Int, cacheBytes: Int, cacheCount: Int, visibleCount: Int) {
        (flights.count, bytes, cached.count, visible.count)
    }

    init(items: [BoardItem], boardID: UUID, rootURL: URL?, pdfOwnerIDs: Set<UUID> = []) {
        self.items = items
        if let rootURL {
            let source = DocumentLibrary(rootURL: rootURL)
            source.annotationOwnersToHide = pdfOwnerIDs.union([boardID])
            library = source
        }
        super.init(frame: .zero)
        // Ink colors belong to the document. A light paper surface preserves
        // black handwriting even when the surrounding app uses dark appearance.
        backgroundColor = UIColor(white: 0.97, alpha: 1)
        isOpaque = true; contentMode = .redraw
        accessibilityIdentifier = "inkReplay.background"
    }
    required init?(coder: NSCoder) { fatalError("Use init(items:boardID:rootURL:)") }

    func update(viewport: CGRect, zoom: CGFloat) {
        guard !released, InkReplayFraming.valid(viewport), zoom.isFinite, zoom > 0 else { return }
        self.viewport = viewport; self.zoom = zoom
        contentScaleFactor = window?.screen.scale ?? traitCollection.displayScale
        visibleTotal = items.lazy.filter { $0.kind != .inkGroup && InkReplayFraming.valid($0.rect) && $0.rect.intersects(viewport) }.count
        visible = InkReplayFraming.visible(items, viewport: viewport, limit: 256)
        desired = InkReplayFraming.visible(items, viewport: viewport, limit: 48).compactMap { item in
            guard needsImage(item), min(item.width, item.height) * zoom >= 3 else { return nil }
            let length = min(1_024, max(64, Int(ceil(max(item.width, item.height) * zoom * contentScaleFactor))))
            let tier = [64, 128, 256, 512, 1_024].first { $0 >= length } ?? 1_024
            return Job(item: item, key: Key(id: item.id, length: tier))
        }
        // Keep the entire desired working set below the cache budget. Without
        // this cap, a 48-page overview could endlessly evict and decode itself.
        var detailCap = 1_024
        while detailCap > 64 && desired.reduce(0, { $0 + min(detailCap, $1.key.length) * min(detailCap, $1.key.length) * 4 }) > 3 * 1_024 * 1_024 {
            detailCap /= 2
        }
        desired = desired.map { Job(item: $0.item, key: Key(id: $0.key.id, length: min(detailCap, $0.key.length))) }
        // Reuse the existing vector-tile planner without its separate 40 MiB
        // cache. These requests share this 16 MiB cache and two-job queue.
        // At most ten center-first 512px tiles (10 MiB) plus <=3 MiB overviews.
        let details = BoardPDFDetailPipeline.tiles(items: visible, viewport: viewport, zoom: zoom,
            displayScale: contentScaleFactor).prefix(10).map { tile in
                let crop = tile.region.normalizedRect
                let key = Key(id: tile.item.id, length: 512,
                    tile: [Double(crop.minX), Double(crop.minY), Double(crop.width), Double(crop.height),
                           Double(tile.region.pixelSize.width), Double(tile.region.pixelSize.height)])
                return Job(item: tile.item, key: key, region: tile.region, rect: tile.rect)
            }
        desired = Array(desired.prefix(2)) + details + Array(desired.dropFirst(2))
        let wanted = Set(desired.map(\.key))
        for (key, token) in flights where !wanted.contains(key) { token.cancel(); flights.removeValue(forKey: key) }
        for job in desired where cached[job.key] != nil { tick += 1; cached[job.key]?.tick = tick }
        pump(); updateStatus(); setNeedsDisplay()
    }
    private func needsImage(_ item: BoardItem) -> Bool {
        guard !BoardVideo.isVideo(item) else { return false }
        return item.kind == .pdfPage || (item.kind == .document && item.sourcePath != nil)
    }
    private func pump() {
        guard !released, let library else { return }
        for job in desired {
            guard flights.count < 2 else { break }
            guard cached[job.key] == nil, flights[job.key] == nil, !failed.contains(job.item.id) else { continue }
            let token = BoardPreviewCancellation(); flights[job.key] = token
            library.viewportThumbnail(item: job.item, pixelLength: job.key.length, token: token, region: job.region) { [weak self] result in
                guard let self, !self.released, self.flights[job.key] === token, !token.isCancelled else { return }
                self.flights.removeValue(forKey: job.key)
                switch result {
                case .success(let rendered):
                    let image = rendered.image
                    let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? Int(image.size.width * image.size.height * image.scale * image.scale * 4)
                    if cost > 0 && cost <= self.budget {
                        // Replace older tiers of this page only after a new image
                        // arrives, so a zoom gesture doesn't erase the background.
                        if job.key.tile == nil {
                            for key in self.cached.keys.filter({ $0.id == job.key.id && $0.tile == nil }) { self.remove(key) }
                        }
                        while self.bytes + cost > self.budget || self.cached.count >= 80 {
                            guard let oldest = self.cached.min(by: { $0.value.tick < $1.value.tick })?.key else { break }
                            self.remove(oldest)
                        }
                        self.tick += 1; self.cached[job.key] = Cached(image: image, cost: cost, tick: self.tick, rect: job.rect)
                        self.bytes += cost
                    } else { self.failed.insert(job.item.id) }
                case .failure: self.failed.insert(job.item.id)
                }
                self.pump(); self.updateStatus(); self.setNeedsDisplay()
            }
        }
    }
    private func remove(_ key: Key) {
        if let value = cached.removeValue(forKey: key) { bytes -= value.cost }
    }
    private func image(for item: BoardItem) -> UIImage? {
        cached.filter { $0.key.id == item.id && $0.key.tile == nil }.max { $0.key.length < $1.key.length }?.value.image
    }
    private func updateStatus() {
        let unavailable = visible.filter { needsImage($0) && (library == nil || failed.contains($0.id)) }.count
        let next: String
        if unavailable > 0 { next = String(localized: "\(unavailable) 项资料背景未加载；笔迹仍可回放，请确认原文件已下载。") }
        else if !flights.isEmpty { next = String(localized: "正在加载当前位置的资料背景…") }
        else if visibleTotal > 256 { next = String(localized: "当前区域资料较多，请放大查看细节。") }
        else if visible.isEmpty { next = String(localized: "当前位置没有资料背景；笔迹仍可回放。") }
        else { next = String(localized: "资料背景为只读快照；单指移动或双指缩放会暂停跟随。") }
        if status != next { status = next; onStatus?(next) }
    }
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        (backgroundColor ?? .white).setFill(); context.fill(bounds)
        for item in visible.reversed() {
            let frame = CGRect(x: (item.x - viewport.minX) * zoom, y: (item.y - viewport.minY) * zoom,
                               width: item.width * zoom, height: item.height * zoom)
            guard frame.width > 0, frame.height > 0, frame.intersects(bounds) else { continue }
            context.saveGState(); context.clip(to: frame)
            UIColor.white.setFill(); context.fill(frame)
            if item.kind == .text || item.kind == .formula {
                drawText(item, frame: frame, context: context)
            } else if let image = image(for: item) {
                image.draw(in: frame)
            } else if frame.width >= 40 && frame.height >= 24 {
                let font = UIFont.systemFont(ofSize: max(8, min(18, 15 * zoom)), weight: .medium)
                let caption = item.title + (needsImage(item) ? "\n" + (failed.contains(item.id) || library == nil
                    ? String(localized: "资料背景未加载") : String(localized: "资料背景加载中")) : "")
                (caption as NSString).draw(in: frame.insetBy(dx: 8, dy: 8), withAttributes: [.font: font, .foregroundColor: UIColor.darkGray])
            }
            // Overlay only currently wanted vector crops, in the same world
            // coordinates as the full-page image and PencilKit ink.
            for job in desired where job.item.id == item.id && job.region != nil {
                if let entry = cached[job.key], let world = entry.rect {
                    entry.image.draw(in: CGRect(x: (world.minX - viewport.minX) * zoom,
                        y: (world.minY - viewport.minY) * zoom, width: world.width * zoom, height: world.height * zoom))
                }
            }
            context.setStrokeColor(UIColor.black.withAlphaComponent(0.12).cgColor)
            context.setLineWidth(1); context.stroke(frame)
            context.restoreGState()
        }
    }
    private func drawText(_ item: BoardItem, frame: CGRect, context: CGContext) {
        if item.style != nil {
            BoardStyledDrawing.card(item, frame: frame, scale: zoom, selected: false, formula: nil, context: context)
            return
        }
        let padding = 12 * zoom
        let body = frame.insetBy(dx: padding, dy: padding)
        guard body.width > 0, body.height > 0 else { return }
        let size = max(1, (item.style?.fontSize ?? 16) * zoom)
        let font = item.usesMonospacedText ? UIFont.monospacedSystemFont(ofSize: size, weight: .regular) : UIFont.systemFont(ofSize: size)
        let content = item.text?.isEmpty == false ? item.text! : item.title
        (content as NSString).draw(in: body, withAttributes: [.font: font, .foregroundColor: UIColor.darkText])
    }
    func reload() {
        guard !released else { return }
        flights.values.forEach { $0.cancel() }; flights.removeAll()
        failed.removeAll(); cached.removeAll(); bytes = 0
        // Source revisions are re-read by the existing worker. This retries
        // iCloud arrivals without modifying the playback position or source.
        pump(); updateStatus(); setNeedsDisplay()
    }
    func tearDown() {
        released = true; flights.values.forEach { $0.cancel() }; flights.removeAll()
        cached.removeAll(); desired.removeAll(); visible.removeAll(); bytes = 0
        library = nil; onStatus = nil
    }
}
