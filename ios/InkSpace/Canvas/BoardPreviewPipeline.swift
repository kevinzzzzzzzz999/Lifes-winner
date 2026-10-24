import UIKit

struct BoardPreviewMetrics {
    let visibleCount: Int
    let readyCount: Int
    let inFlight: Int
    let queued: Int
    let cacheCount: Int
    let cacheBytes: Int
    let overviewBytes: Int
    let detailBytes: Int
    let completed: Int
    let discarded: Int
}

/// Presentation-only, explicitly bounded two-tier bitmap cache. UIKit redraws are
/// coalesced by the owner; completing a thumbnail never broadcasts a board change.
@MainActor
final class BoardPreviewPipeline {
    private struct Content: Equatable {
        let path: String?
        let page: Int?
        let text: String?
        let style: BoardItemStyle?
        let richHTML: String?
        let textFormat: String?
        let ink: Data?
        let width: Double
        let height: Double
        let kind: BoardItemKind
        init(_ item: BoardItem) {
            path = item.sourcePath; page = item.page; kind = item.kind
            text = item.usesFormulaRendering || item.usesRichTextRendering ? (item.text ?? item.title) : nil
            richHTML = item.usesRichTextRendering ? item.richTextHTML : nil
            textFormat = item.usesRichTextRendering ? item.resolvedBoxTextFormat : nil
            style = item.usesFormulaRendering || item.usesRichTextRendering ? item.style : nil
            ink = item.inkData
            width = item.kind == .inkGroup || item.usesRichTextRendering ? item.width : 0
            height = item.kind == .inkGroup ? item.height : 0
        }
    }
    private struct State { let content: Content; let generation: Int }
    private struct Key: Hashable { let id: UUID; let generation: Int; let tier: Int }
    private struct Entry { let image: UIImage; let cost: Int; var tick: Int }
    private struct Wanted { let item: BoardItem; let generation: Int; let tier: Int }
    private struct Flight { let token: BoardPreviewCancellation; let requestID: UUID }
    private var states: [UUID: State] = [:]
    private var wanted: [Wanted] = []
    private var entries: [Key: Entry] = [:]
    private var inFlight: [Key: Flight] = [:]
    private var attempted: Set<Key> = []
    private var failed: Set<UUID> = []
    private var revisions: [String: String] = [:]
    private var generation = 0
    private var tick = 0
    private var completed = 0
    private var discarded = 0
    private var overviewBytes = 0
    private var overviewCap = 64
    private var detailBytes = 0
    private var scheduled = false
    private let byteLimit = 16 * 1_024 * 1_024 // Per tier, 32 MiB combined.
    private weak var store: BoardStore?
    var didChange: (() -> Void)?

    var metrics: BoardPreviewMetrics {
        BoardPreviewMetrics(visibleCount: wanted.count, readyCount: wanted.filter { image(for: $0.item.id, touch: false) != nil }.count,
            inFlight: inFlight.count, queued: jobs().count, cacheCount: entries.count,
            cacheBytes: overviewBytes + detailBytes, overviewBytes: overviewBytes, detailBytes: detailBytes,
            completed: completed, discarded: discarded)
    }

    /// Tiers use physical pixels, never world coordinates. Below two pixels on
    /// the short edge, the compositor draws the page outline without new decoding.
    static func tier(for size: CGSize, displayScale: CGFloat, richText: Bool = false) -> Int {
        let short = min(size.width, size.height) * displayScale
        let long = max(size.width, size.height) * displayScale
        guard short.isFinite, long.isFinite, short >= 2 else { return 0 }
        let tiers = richText ? [32,64,128,256,512,1_024,2_048,4_096] : [32,64,128,256,512,1_024]
        return tiers.first { CGFloat($0) >= long } ?? tiers.last!
    }

    func update(items: [BoardItem], zoom: CGFloat, displayScale: CGFloat, store: BoardStore) {
        let sameStore = self.store === store
        self.store = store
        var next: [Wanted] = []
        for item in items {
            let content = Content(item)
            if states[item.id]?.content != content {
                invalidate(id: item.id)
                generation += 1; states[item.id] = State(content: content, generation: generation)
            }
            let tier = Self.tier(for: CGSize(width: item.width * zoom, height: item.height * zoom), displayScale: displayScale, richText: item.usesRichTextRendering)
            next.append(Wanted(item: item, generation: states[item.id]!.generation, tier: tier))
        }
        // Fit the entire current detail working set, not each image in
        // isolation. This also suppresses thousands of pointless 128px jobs on
        // a 3x display when tiny overview cards just cross a tier boundary.
        let detailCount = next.filter { $0.tier > 64 }.count
        var detailCap = detailCount > 128 ? 64 : 4_096
        while detailCap > 64 {
            let bytes = next.reduce(0) { total, item in
                total + (item.tier > 64 ? min(detailCap, item.tier) * min(detailCap, item.tier) * 4 : 0)
            }
            if bytes <= byteLimit { break }
            detailCap /= 2
        }
        next = next.map { Wanted(item: $0.item, generation: $0.generation, tier: min($0.tier, detailCap)) }

        // Keep a complete overview affordable even when 2,000 pages overlap or
        // a Retina display would otherwise ask for 2,000 separate 64px images.
        var cap = 64
        while cap > 16 {
            let bytes = next.reduce(0) { $0 + ($1.tier > 0 ? min(cap, $1.tier) * min(cap, $1.tier) * 4 : 0) }
            if bytes <= byteLimit * 9 / 10 { break }
            cap /= 2
        }
        if cap != overviewCap {
            overviewCap = cap
            // Remove larger overview variants only after their small replacement
            // arrives; zooming never clears the last available image.
            attempted = attempted.filter { $0.tier > 64 || $0.tier == cap }
        }
        let sameRequests = sameStore && wanted.count == next.count && zip(wanted, next).allSatisfy {
            $0.0.item.id == $0.1.item.id && $0.0.generation == $0.1.generation && $0.0.tier == $0.1.tier
        }
        wanted = next
        // A pan within the same pixel buckets changes no decoding request.
        // Keep the latest item values without rebuilding cancellation sets or
        // waking the worker on every small viewport movement.
        if sameRequests { return }
        let visible = Set(next.map { $0.item.id })
        let validGenerations = Dictionary(uniqueKeysWithValues: next.map { ($0.item.id, $0.generation) })
        let desiredTiers = Dictionary(uniqueKeysWithValues: next.map { ($0.item.id, $0.tier) })
        for (key, flight) in inFlight where !visible.contains(key.id) || validGenerations[key.id] != key.generation
            || desiredTiers[key.id] == 0 || (key.tier > 64 && key.tier != desiredTiers[key.id]) {
            flight.token.cancel(); inFlight.removeValue(forKey: key); attempted.remove(key); discarded += 1
        }
        attempted = attempted.filter { key in
            guard visible.contains(key.id), validGenerations[key.id] == key.generation,
                  let target = desiredTiers[key.id], target > 0 else { return false }
            return key.tier == min(overviewCap, target) || (target > 64 && key.tier == target)
        }
        let retained = visible.union(entries.keys.map(\.id))
        states = states.filter { retained.contains($0.key) }
        schedule()
    }

    func hasFailed(for id: UUID) -> Bool { failed.contains(id) }

    func image(for id: UUID) -> UIImage? { image(for: id, touch: true) }

    private func image(for id: UUID, touch: Bool) -> UIImage? {
        guard let state = states[id] else { return nil }
        // A lower-resolution image remains visible while its replacement loads.
        for tier in [4_096, 2_048, 1_024, 512, 256, 128, 64, 32, 16] {
            let key = Key(id: id, generation: state.generation, tier: tier)
            if var entry = entries[key] {
                if touch { tick += 1; entry.tick = tick; entries[key] = entry }
                return entry.image
            }
        }
        return nil
    }

    func sourceRevisions(_ values: [String: String]) {
        var changed = false
        for (path, revision) in values {
            if let old = revisions[path], old != revision {
                let ids = states.filter { $0.value.content.path == path }.map(\.key)
                for id in ids {
                    invalidate(id: id)
                    if let state = states[id] {
                        generation += 1; states[id] = State(content: state.content, generation: generation)
                    }
                }
                for index in wanted.indices where wanted[index].item.sourcePath == path {
                    let old = wanted[index]
                    wanted[index] = Wanted(item: old.item, generation: states[old.item.id]!.generation, tier: old.tier)
                }
                changed = true
            }
            revisions[path] = revision
        }
        if changed { didChange?(); schedule() }
    }

    func reset() {
        inFlight.values.forEach { $0.token.cancel() }
        inFlight.removeAll(); entries.removeAll(); states.removeAll(); wanted.removeAll()
        attempted.removeAll(); failed.removeAll(); revisions.removeAll(); overviewBytes = 0; detailBytes = 0
        generation += 1; scheduled = false
    }

    private func invalidate(id: UUID) {
        failed.remove(id)
        for key in entries.keys.filter({ $0.id == id }) { remove(key) }
        for (key, flight) in inFlight where key.id == id {
            flight.token.cancel(); inFlight.removeValue(forKey: key); discarded += 1
        }
        attempted = attempted.filter { $0.id != id }
    }

    private func jobs() -> [(Wanted, Key)] {
        var overview: [(Wanted, Key)] = [], detail: [(Wanted, Key)] = []
        for item in wanted where item.tier > 0 {
            let base = min(overviewCap, item.tier)
            let low = Key(id: item.item.id, generation: item.generation, tier: base)
            if entries[low] == nil, !attempted.contains(low), inFlight[low] == nil { overview.append((item, low)) }
            if item.tier > 64 {
                let high = Key(id: item.item.id, generation: item.generation, tier: item.tier)
                if entries[high] == nil, !attempted.contains(high), inFlight[high] == nil { detail.append((item, high)) }
            }
        }
        return overview + detail
    }

    private func schedule() {
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in self?.scheduled = false; self?.pump() }
    }

    private func pump() {
        guard let store else { return }
        for (wanted, key) in jobs().prefix(max(0, 2 - inFlight.count)) {
            attempted.insert(key)
            let id = UUID(), token = BoardPreviewCancellation()
            inFlight[key] = Flight(token: token, requestID: id)
            let completion: (Result<BoardPreviewImage, Error>) -> Void = { [weak self] result in
                guard let self else { return }
                guard self.inFlight[key]?.requestID == id else { self.discarded += 1; return }
                self.inFlight.removeValue(forKey: key)
                guard self.states[key.id]?.generation == key.generation,
                      self.wanted.contains(where: { $0.item.id == key.id }) else { self.discarded += 1; self.schedule(); return }
                if case .success(let rendered) = result {
                    if let path = wanted.item.sourcePath, wanted.item.kind != .inkGroup, !wanted.item.usesFormulaRendering, !wanted.item.usesRichTextRendering {
                        if let old = self.revisions[path], old != rendered.revision {
                            // A newly rendered version must not coexist with cached old pages.
                            self.sourceRevisions([path: rendered.revision]); self.discarded += 1
                            self.schedule(); return
                        }
                        self.revisions[path] = rendered.revision
                    }
                    self.failed.remove(key.id); self.insert(rendered.image, for: key); self.completed += 1; self.didChange?()
                } else if wanted.item.usesRichTextRendering {
                    self.failed.insert(key.id); self.didChange?()
                }
                self.schedule()
            }
            if wanted.item.usesRichTextRendering {
                BoardRichTextRenderer.render(item:wanted.item,pixelLength:key.tier,token:token,completion:completion)
            } else { store.requestViewportThumbnail(for:wanted.item,pixelLength:key.tier,token:token,completion:completion) }
        }
    }

    private func insert(_ image: UIImage, for key: Key) {
        guard let cg = image.cgImage else { return }
        let cost = cg.bytesPerRow * cg.height
        guard cost > 0, cost <= byteLimit else { return }
        remove(key)
        let low = key.tier <= 64, countLimit = low ? 4_096 : 128
        // Keep one variant per item in each bucket. Replacing the previous
        // detail only after the new one arrives avoids both a blank flash and
        // old 1024px variants consuming the budget reserved for 512px targets.
        for old in entries.keys.filter({ $0.id == key.id && $0.generation == key.generation && ($0.tier <= 64) == low }) { remove(old) }
        func bucketKeys() -> [Key] { entries.keys.filter { ($0.tier <= 64) == low } }
        while (low ? overviewBytes : detailBytes) + cost > byteLimit || bucketKeys().count >= countLimit {
            guard let oldest = bucketKeys().min(by: { entries[$0]!.tick < entries[$1]!.tick }) else { break }
            remove(oldest)
        }
        tick += 1; entries[key] = Entry(image: image, cost: cost, tick: tick)
        if low { overviewBytes += cost } else { detailBytes += cost }
    }

    private func remove(_ key: Key) {
        guard let entry = entries.removeValue(forKey: key) else { return }
        if key.tier <= 64 { overviewBytes -= entry.cost } else { detailBytes -= entry.cost }
    }
}

struct BoardPDFDetailMetrics {
    let visibleTiles: Int
    let readyTiles: Int
    let inFlight: Int
    let queued: Int
    let cacheBytes: Int
    let completed: Int
}

/// A separate, bounded close-reading layer. The overview remains visible during
/// panning; PDF vectors are decoded only for the viewport's physical-pixel tiles.
/// Full-page thumbnails intentionally keep their existing 1024px / 32MiB bound.
@MainActor
final class BoardPDFDetailPipeline {
    struct Tile {
        let item: BoardItem
        let rect: CGRect
        let region: BoardPDFTileRegion
        fileprivate let key: Key
    }
    fileprivate struct Key: Hashable {
        let id: UUID
        let path: String
        let page: Int
        let width: Double
        let height: Double
        let scale: CGFloat
        let column: Int
        let row: Int
    }
    private struct Entry { let image: UIImage; let bytes: Int; var tick: Int }
    private struct Flight { let id: UUID; let token: BoardPreviewCancellation }
    static let byteLimit = 40 * 1_024 * 1_024
    static let tileLimit = 36
    private weak var library: DocumentLibrary?
    private var wanted: [Tile] = []
    private var viewport = CGRect.null
    private var cache: [Key: Entry] = [:]
    private var flights: [Key: Flight] = [:]
    private var attempted = Set<Key>()
    private var revisions: [String: String] = [:]
    private var bytes = 0, tick = 0, completed = 0
    private var scheduled = false
    var didChange: (() -> Void)?

    var metrics: BoardPDFDetailMetrics {
        BoardPDFDetailMetrics(visibleTiles: wanted.count, readyTiles: wanted.filter { cache[$0.key] != nil }.count,
            inFlight: flights.count, queued: jobs.count, cacheBytes: bytes, completed: completed)
    }

    /// Rounded scale levels avoid decoding anew for each small pinch movement.
    /// Power-of-two rounding always meets the requested display density.
    static func renderScale(zoom: CGFloat, displayScale: CGFloat) -> CGFloat {
        let requested = zoom * displayScale
        guard requested.isFinite, requested > 0 else { return 0 }
        return min(32, max(0.125, pow(2, ceil(log2(requested)))))
    }

    static func tiles(items: [BoardItem], viewport: CGRect, zoom: CGFloat, displayScale: CGFloat) -> [Tile] {
        let scale = renderScale(zoom: zoom, displayScale: displayScale)
        guard scale > 0, viewport.isFiniteCanvasRect, viewport.width > 0, viewport.height > 0 else { return [] }
        var result: [Tile] = []
        // Center-first input from the compositor gives the current reading page
        // priority even when a board contains thousands of overlapping cards.
        for item in items where item.kind == .pdfPage && item.sourcePath?.lowercased().hasSuffix(".pdf") == true {
            let rect = item.canvasWorldRect, visible = rect.intersection(viewport)
            guard rect.isFiniteCanvasRect, rect.width > 0, rect.height > 0,
                  !visible.isNull, visible.width > 0, visible.height > 0,
                  max(rect.width, rect.height) * zoom * displayScale > 1_024 else { continue }
            let fullWidth = rect.width * scale, fullHeight = rect.height * scale
            let startX = max(0, Int(floor((visible.minX - rect.minX) * scale / 512)))
            let endX = max(startX, Int(ceil((visible.maxX - rect.minX) * scale / 512)) - 1)
            let startY = max(0, Int(floor((visible.minY - rect.minY) * scale / 512)))
            let endY = max(startY, Int(ceil((visible.maxY - rect.minY) * scale / 512)) - 1)
            // Invalid/enormous synthetic windows must not build huge ranges.
            guard endX - startX < 128, endY - startY < 128 else { continue }
            var pageTiles: [Tile] = []
            for row in startY...endY {
                for column in startX...endX {
                    let x = CGFloat(column) * 512, y = CGFloat(row) * 512
                    let width = min(512, fullWidth - x), height = min(512, fullHeight - y)
                    guard width > 0, height > 0 else { continue }
                    let region = BoardPDFTileRegion(
                        normalizedRect: CGRect(x: x / fullWidth, y: y / fullHeight, width: width / fullWidth, height: height / fullHeight),
                        pixelSize: CGSize(width: ceil(width), height: ceil(height)))
                    let key = Key(id: item.id, path: item.sourcePath!, page: max(1, item.page ?? 1),
                                  width: item.width, height: item.height, scale: scale, column: column, row: row)
                    pageTiles.append(Tile(item: item, rect: CGRect(x: rect.minX + x / scale, y: rect.minY + y / scale,
                        width: width / scale, height: height / scale), region: region, key: key))
                }
            }
            pageTiles.sort { hypot($0.rect.midX - visible.midX, $0.rect.midY - visible.midY) < hypot($1.rect.midX - visible.midX, $1.rect.midY - visible.midY) }
            result.append(contentsOf: pageTiles.prefix(max(0, tileLimit - result.count)))
            if result.count >= tileLimit { break }
        }
        return result
    }

    func update(items: [BoardItem], viewport: CGRect, zoom: CGFloat, displayScale: CGFloat, library: DocumentLibrary?) {
        if self.library !== library { reset(); self.library = library }
        guard library != nil else { return }
        let next = Self.tiles(items: items, viewport: viewport, zoom: zoom, displayScale: displayScale)
        let sameRequests = wanted.count == next.count && zip(wanted, next).allSatisfy { $0.0.key == $0.1.key }
        self.viewport = viewport
        wanted = next
        if sameRequests { return }
        let keys = Set(wanted.map(\.key))
        for (key, flight) in flights where !keys.contains(key) && !isUsefulFallback(key) {
            flight.token.cancel(); flights.removeValue(forKey: key)
        }
        attempted = attempted.intersection(keys.union(flights.keys))
        schedule()
    }

    func images(for id: UUID) -> [(image: UIImage, rect: CGRect)] {
        let current = wanted.filter { $0.item.id == id }
        guard !current.isEmpty else { return [] }
        let ready = current.filter { cache[$0.key] != nil }
        let currentKeys = Set(wanted.map(\.key))
        let readyCount = wanted.reduce(0) { $0 + (cache[$1.key] != nil ? 1 : 0) }
        var pages: [UUID: Tile] = [:]
        for tile in wanted where pages[tile.item.id] == nil { pages[tile.item.id] = tile }
        // Pinching across a scale bucket must not hide already-decoded text.
        // Reuse matching source/page/geometry tiles while the requested scale
        // catches up. No extra bitmap is allocated and output stays at 36 tiles.
        let fallback = cache.keys.filter { !currentKeys.contains($0) && isUsefulFallback($0, page: pages[$0.id]) }.sorted {
            let aPage = pages[$0.id]!, bPage = pages[$1.id]!
            let a = abs(log2($0.scale / aPage.key.scale)), b = abs(log2($1.scale / bPage.key.scale))
            if a != b { return a < b }
            let aRect = Self.rect(for: $0, item: aPage.item), bRect = Self.rect(for: $1, item: bPage.item)
            let aDistance = hypot(aRect.midX - viewport.midX, aRect.midY - viewport.midY)
            let bDistance = hypot(bRect.midX - viewport.midX, bRect.midY - viewport.midY)
            if aDistance != bDistance { return aDistance < bDistance }
            if $0.scale != $1.scale { return $0.scale < $1.scale }
            if $0.id != $1.id { return $0.id.uuidString < $1.id.uuidString }
            if $0.row != $1.row { return $0.row < $1.row }
            return $0.column < $1.column
        }.prefix(max(0, Self.tileLimit - readyCount)).filter { $0.id == id }.sorted {
            // Paint fallback from coarse to fine, then current-scale images.
            if $0.scale != $1.scale { return $0.scale < $1.scale }
            if $0.row != $1.row { return $0.row < $1.row }
            return $0.column < $1.column
        }
        let displayed = fallback.map { ($0, Self.rect(for: $0, item: pages[$0.id]!.item)) }
            + ready.map { ($0.key, $0.rect) }
        return displayed.compactMap { key, rect in
            guard var entry = cache[key] else { return nil }
            tick += 1; entry.tick = tick; cache[key] = entry
            return (entry.image, rect)
        }
    }

    private static func rect(for key: Key, item: BoardItem) -> CGRect {
        let x = CGFloat(key.column) * 512, y = CGFloat(key.row) * 512
        return CGRect(x: item.x + x / key.scale, y: item.y + y / key.scale,
            width: min(512, CGFloat(key.width) * key.scale - x) / key.scale,
            height: min(512, CGFloat(key.height) * key.scale - y) / key.scale)
    }

    private func isUsefulFallback(_ key: Key, page: Tile? = nil) -> Bool {
        guard let page = page ?? wanted.first(where: { $0.key.id == key.id }),
              key.id == page.key.id, key.path == page.key.path, key.page == page.key.page,
              key.width == page.key.width, key.height == page.key.height else { return false }
        let rect = Self.rect(for: key, item: page.item)
        return rect.isFiniteCanvasRect && rect.width > 0 && rect.height > 0 && rect.intersects(viewport)
    }

    func sourceRevisions(_ values: [String: String]) {
        var changed = false
        for (path, revision) in values {
            if let old = revisions[path], old != revision { invalidate(path: path); changed = true }
            revisions[path] = revision
        }
        if changed { didChange?(); schedule() }
    }

    func reset() {
        flights.values.forEach { $0.token.cancel() }
        flights.removeAll(); wanted.removeAll(); cache.removeAll(); attempted.removeAll(); revisions.removeAll()
        viewport = .null
        bytes = 0; scheduled = false
    }

    private var jobs: [Tile] { wanted.filter { cache[$0.key] == nil && flights[$0.key] == nil && !attempted.contains($0.key) } }
    private func schedule() {
        guard !scheduled else { return }
        scheduled = true
        DispatchQueue.main.async { [weak self] in self?.scheduled = false; self?.pump() }
    }
    private func pump() {
        guard flights.isEmpty, let library, let tile = jobs.first else { return }
        let key = tile.key, id = UUID(), token = BoardPreviewCancellation()
        flights[key] = Flight(id: id, token: token); attempted.insert(key)
        library.viewportThumbnail(item: tile.item, pixelLength: 512, token: token, region: tile.region) { [weak self] result in
            guard let self, self.flights[key]?.id == id else { return }
            self.flights.removeValue(forKey: key)
            guard self.wanted.contains(where: { $0.key == key }) || self.isUsefulFallback(key) else { self.schedule(); return }
            if case .success(let rendered) = result {
                // A newly observed source version invalidates all previous tiles
                // for the file before the new vector crop becomes visible.
                self.sourceRevisions([key.path: rendered.revision])
                if let cg = rendered.image.cgImage {
                    let cost = cg.bytesPerRow * cg.height
                    if cost > 0, cost <= Self.byteLimit {
                        while self.bytes + cost > Self.byteLimit, let oldest = self.cache.min(by: { $0.value.tick < $1.value.tick })?.key { self.remove(oldest) }
                        self.remove(key); self.tick += 1
                        self.cache[key] = Entry(image: rendered.image, bytes: cost, tick: self.tick)
                        self.bytes += cost; self.completed += 1; self.didChange?()
                    }
                }
            }
            self.schedule()
        }
    }
    private func invalidate(path: String) {
        for key in cache.keys.filter({ $0.path == path }) { remove(key) }
        for (key, flight) in flights where key.path == path { flight.token.cancel(); flights.removeValue(forKey: key) }
        attempted = attempted.filter { $0.path != path }
    }
    private func remove(_ key: Key) { if let entry = cache.removeValue(forKey: key) { bytes -= entry.bytes } }
}
