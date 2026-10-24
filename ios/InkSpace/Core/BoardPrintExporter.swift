import Foundation
import UIKit
import PencilKit
import PDFKit
import ImageIO
import UniformTypeIdentifiers

// These scopes refer only to a frozen board snapshot. Export never saves, modifies,
// or synchronizes a vault source and never reads the viewport thumbnail cache.
enum BoardExportScope { case printFrames([BoardPrintFrame]), selection(CGRect), allContent }
enum BoardExportFormat: String, CaseIterable, Identifiable {
    case pdf, png, jpeg
    var id: String { rawValue }
    var title: String { rawValue.uppercased() }
    var fileExtension: String { self == .jpeg ? "jpg" : rawValue }
}
struct BoardExportOptions {
    var scope: BoardExportScope
    var format: BoardExportFormat = .pdf
    var dpi: Double = 216
}
struct BoardExportProgress { let completedPages: Int; let totalPages: Int; let message: String }
struct BoardExportResult {
    let directory: URL
    let files: [URL]
    let pageCount: Int
    let warnings: [String]
    /// The caller owns this private temporary export and can remove it after sharing.
    func removeTemporaryFiles() { try? FileManager.default.removeItem(at: directory) }
}

@MainActor
final class BoardPrintExporter {
    private struct PagePlan {
        let source: CGRect
        let clip: CGRect
        let paper: CGSize
        let destination: CGRect
        let footer: Bool
        var scale: CGFloat { destination.width / source.width }
        func paperRect(for worldRect: CGRect) -> CGRect {
            CGRect(x: destination.minX + (worldRect.minX - source.minX) * scale,
                   y: destination.minY + (worldRect.minY - source.minY) * scale,
                   width: worldRect.width * scale, height: worldRect.height * scale)
        }
    }
    private struct CachedPDF { let document: PDFDocument; let bytes: Int }
    private let sourceStore: SourceDocumentRenderStore
    private let formulaRenderer: FormulaRenderer
    private var pdfCache: [String: CachedPDF] = [:]
    private var cacheOrder: [String] = []
    private var verifiedCards = Set<String>()
    private var sourceDigests: [String: String] = [:]
    private var active = false
    private var fallbackWebInk: [BoardWebStroke] = []
    private let maximumFileBytes = 256 * 1_024 * 1_024
    private let maximumTotalBytes = 1_024 * 1_024 * 1_024
    private let maximumPixels = 24_000_000

    init(rootURL: URL, bundle: Bundle = .main) {
        sourceStore = SourceDocumentRenderStore(rootURL: rootURL)
        formulaRenderer = FormulaRenderer(bundle: bundle)
    }

    /// drawingData is the GLOBAL native drawing only. This method also merges
    /// every inkGroup using its translation exactly once (including erasure masks).
    func export(snapshot: BoardDocument, drawingData: Data? = nil, options: BoardExportOptions,
                progress: @escaping (BoardExportProgress) -> Void = { _ in }) async throws -> BoardExportResult {
        guard !active else { throw BoardPrintError.outputFailed }
        active = true
        defer { active = false; pdfCache.removeAll(); cacheOrder.removeAll(); verifiedCards.removeAll(); sourceDigests.removeAll(); fallbackWebInk = [] }
        try snapshot.validate()
        try Task.checkCancellation()
        guard options.dpi.isFinite, (72...300).contains(options.dpi) else { throw BoardPrintError.invalidGeometry }
        let native = try await Self.worldDrawing(data: drawingData ?? snapshot.drawing, items: snapshot.items)
        // A web-only board has no PencilKit source; retain its visible paths as
        // vector marks, never claim that another app can erase native strokes.
        fallbackWebInk = native.strokes.isEmpty ? try Self.validatedWebInk(snapshot.webInk) : []
        let ink = native
        let plans: [PagePlan]
        if case .allContent = options.scope {
            plans = try makePlans(.printFrames(Self.automaticFrames(snapshot: snapshot, ink: ink, web: fallbackWebInk)), canvasSize: snapshot.canvasWidth)
        } else { plans = try makePlans(options.scope, canvasSize: snapshot.canvasWidth) }
        guard !plans.isEmpty else { throw BoardPrintError.invalidGeometry }
        for owner in snapshot.items {
            for child in owner.childBoards ?? [] where child.presentation?.expanded == true {
                if let rect = child.presentation?.rect, plans.contains(where: { $0.clip.intersects(rect) }) {
                    throw BoardExportContentError.expandedChild(child.title)
                }
            }
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("InkSpace-Export-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        var success = false
        defer { if !success { try? FileManager.default.removeItem(at: directory) } }
        var files: [URL] = []
        let stem = Self.safeFilename(snapshot.title)
        if options.format == .pdf {
            let url = directory.appendingPathComponent(stem + ".pdf")
            guard let consumer = CGDataConsumer(url: url as CFURL) else { throw BoardPrintError.outputFailed }
            var firstPaper = CGRect(origin: .zero, size: plans[0].paper)
            guard let context = CGContext(consumer: consumer, mediaBox: &firstPaper,
                                          [kCGPDFContextCreator: "人生赢家", kCGPDFContextTitle: snapshot.title] as CFDictionary) else {
                throw BoardPrintError.outputFailed
            }
            var closed = false
            defer { if !closed { context.closePDF() } }
            for (index, plan) in plans.enumerated() {
                try Task.checkCancellation()
                progress(.init(completedPages: index, totalPages: plans.count, message: String(localized: "正在导出第 \(index + 1) / \(plans.count) 页")))
                var rect = CGRect(origin: .zero, size: plan.paper)
                let media = Data(bytes: &rect, count: MemoryLayout<CGRect>.size)
                context.beginPDFPage([kCGPDFContextMediaBox: media] as CFDictionary)
                let links = try await drawPage(snapshot: snapshot, ink: ink, plan: plan, context: context,
                                               pageNumber: index + 1, dpi: options.dpi)
                for (rect, url) in links {
                    // PDF URLs take default bottom-left page coordinates, after the
                    // world/UI graphics transforms have been popped.
                    context.setURL(url as CFURL, for: CGRect(x: rect.minX, y: plan.paper.height - rect.maxY,
                                                            width: rect.width, height: rect.height))
                }
                context.endPDFPage()
                try checkOutput(url)
                await Task.yield()
            }
            context.closePDF(); closed = true
            try Task.checkCancellation()
            try checkOutput(url)
            guard let pdf = PDFDocument(url: url), pdf.pageCount == plans.count else { throw BoardPrintError.outputFailed }
            for (index, plan) in plans.enumerated() {
                guard let page = pdf.page(at: index), page.bounds(for: .mediaBox).size == plan.paper else {
                    throw BoardPrintError.outputFailed
                }
            }
            files = [url]
        } else {
            var totalBytes = 0
            for (index, plan) in plans.enumerated() {
                try Task.checkCancellation()
                progress(.init(completedPages: index, totalPages: plans.count, message: String(localized: "正在导出第 \(index + 1) / \(plans.count) 张图片")))
                let pixelScale = options.dpi / 72
                let pixels = CGSize(width: ceil(plan.paper.width * pixelScale), height: ceil(plan.paper.height * pixelScale))
                try validatePixels(pixels)
                guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                      let context = CGContext(data: nil, width: Int(pixels.width), height: Int(pixels.height),
                        bitsPerComponent: 8, bytesPerRow: Int(pixels.width) * 4, space: colorSpace,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
                    throw BoardPrintError.regionTooLarge
                }
                context.scaleBy(x: pixels.width / plan.paper.width, y: pixels.height / plan.paper.height)
                _ = try await drawPage(snapshot: snapshot, ink: ink, plan: plan, context: context,
                                      pageNumber: index + 1, dpi: options.dpi)
                guard let image = context.makeImage() else { throw BoardPrintError.outputFailed }
                let filename = plans.count == 1 ? stem : "\(stem)-\(String(format: "%04d", index + 1))"
                let url = directory.appendingPathComponent(filename + "." + options.format.fileExtension)
                let type = options.format == .png ? UTType.png.identifier : UTType.jpeg.identifier
                guard let destination = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil) else {
                    throw BoardPrintError.outputFailed
                }
                CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.92,
                    kCGImagePropertyDPIWidth: options.dpi, kCGImagePropertyDPIHeight: options.dpi] as CFDictionary)
                guard CGImageDestinationFinalize(destination) else { throw BoardPrintError.outputFailed }
                try checkOutput(url)
                totalBytes += (try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? maximumTotalBytes
                guard totalBytes <= maximumTotalBytes else { throw BoardPrintError.regionTooLarge }
                files.append(url)
                await Task.yield()
            }
        }
        try Task.checkCancellation()
        try await verifySources()
        success = true
        progress(.init(completedPages: plans.count, totalPages: plans.count, message: String(localized: "导出完成")))
        return BoardExportResult(directory: directory, files: files, pageCount: plans.count, warnings: [])
    }

    private func makePlans(_ scope: BoardExportScope, canvasSize: Double) throws -> [PagePlan] {
        switch scope {
        case .printFrames(let frames):
            try PrintPageGeometry.validate(frames: frames, canvasSize: canvasSize)
            return frames.map { PagePlan(source: $0.rect, clip: $0.clippedSourceRect, paper: $0.paperSize,
                                         destination: $0.contentRect, footer: true) }
        case .allContent:
            throw BoardPrintError.invalidGeometry // Resolved with complete content above.
        case .selection(let rect):
            guard PrintPageGeometry.valid(rect), rect.minX >= 0, rect.minY >= 0,
                  rect.maxX <= canvasSize, rect.maxY <= canvasSize else { throw BoardPrintError.invalidGeometry }
            // An exact selection is a custom-size PDF/image, with no added margins,
            // footer or surrounding board content. Larger regions use print frames.
            guard rect.width <= 14_400, rect.height <= 14_400 else { throw BoardPrintError.regionTooLarge }
            return [PagePlan(source: rect, clip: rect, paper: rect.size,
                             destination: CGRect(origin: .zero, size: rect.size), footer: false)]
        }
    }

    private nonisolated static func worldDrawing(data: Data?, items: [BoardItem]) async throws -> PKDrawing {
        let worker = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let limit = 256 * 1_024 * 1_024
            var totalBytes = data?.count ?? 0
            guard totalBytes <= limit else { throw BoardPrintError.invalidDrawing }
            var strokes: [PKStroke]
            do { strokes = try data.map { try PKDrawing(data: $0).strokes } ?? [] }
            catch { throw BoardPrintError.invalidDrawing }
            for item in items where item.kind == .inkGroup {
                try Task.checkCancellation()
                guard let bytes = item.inkData, bytes.count <= limit - totalBytes,
                      let drawing = try? PKDrawing(data: bytes) else { throw BoardPrintError.invalidDrawing }
                totalBytes += bytes.count
                strokes += drawing.transformed(using: CGAffineTransform(translationX: item.x, y: item.y)).strokes
            }
            guard strokes.allSatisfy({ [$0.renderBounds.minX, $0.renderBounds.minY, $0.renderBounds.width, $0.renderBounds.height].allSatisfy(\.isFinite) }) else { throw BoardPrintError.invalidDrawing }
            return PKDrawing(strokes: strokes)
        }
        return try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
    }

    private func drawPage(snapshot: BoardDocument, ink: PKDrawing, plan: PagePlan, context: CGContext,
                          pageNumber: Int, dpi: Double) async throws -> [(CGRect, URL)] {
        var links: [(CGRect, URL)] = []
        // All rendering uses a fresh light appearance and no selection/grid/pin UI.
        withPaperContext(context, size: plan.paper) {
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: plan.paper))
        }
        let items = Self.visibleExportItems(snapshot).filter { $0.rect.intersects(plan.clip) }
        withWorldContext(context, plan: plan) { drawEdges(snapshot: snapshot, clip: plan.clip, context: context) }
        for (index, item) in items.enumerated() {
            try Task.checkCancellation()
            if item.kind == .pdfPage {
                guard let path = item.sourcePath, let number = item.page else { throw BoardPrintError.missingSource(item.title) }
                let document = try await loadPDF(path)
                guard let page = document.page(at: number - 1) else { throw BoardPrintError.unreadableSource(path) }
                BoardPDFAnnotationOwners.hide(in: page, owners: snapshot.pdfDisplayOwnerIDs)
                let crop = page.bounds(for: .cropBox)
                let displayed = crop.applying(page.transform(for: .cropBox)).standardized
                guard PrintPageGeometry.valid(displayed) else { throw BoardPrintError.unreadableSource(path) }
                withWorldContext(context, plan: plan) {
                    context.saveGState(); defer { context.restoreGState() }
                    context.clip(to: item.rect)
                    UIColor.white.setFill(); context.fill(item.rect)
                    context.translateBy(x: item.x, y: item.y + item.height)
                    context.scaleBy(x: item.width / displayed.width, y: -item.height / displayed.height)
                    context.translateBy(x: -displayed.minX, y: -displayed.minY)
                    // PDFKit applies the crop origin and rotation itself.
                    page.draw(with: .cropBox, to: context)
                }
                for annotation in page.annotations {
                    guard let action = annotation.action as? PDFActionURL, let url = action.url, Self.safeLink(url) else { continue }
                    let bounds = annotation.bounds.applying(page.transform(for: .cropBox)).standardized
                    let world = CGRect(x: item.x + (bounds.minX - displayed.minX) / displayed.width * item.width,
                                       y: item.y + (displayed.maxY - bounds.maxY) / displayed.height * item.height,
                                       width: bounds.width / displayed.width * item.width, height: bounds.height / displayed.height * item.height)
                    appendLink(url, worldRect: world.intersection(item.rect), plan: plan, to: &links)
                }
            } else if item.usesRichTextRendering {
                let layout = BoardExportCardLayout(item)
                let document = try await loadRichTextPDF(item, body: layout.body)
                guard let page = document.page(at: 0) else { throw BoardExportContentError.unavailable(item.title) }
                let destination = try BoardExportContent.fittedContent(size: page.bounds(for: .mediaBox).size, in: layout.body, title: item.title)
                try Task.checkCancellation()
                withWorldContext(context, plan: plan) {
                    drawCard(item, formula: nil, context: context)
                    drawContentPDF(page, in: destination, context: context)
                }
                appendContentLinks(page, destination: destination, plan: plan, to: &links)
            } else if item.kind == .document, let path = item.sourcePath,
                      ["png", "jpg", "jpeg"].contains((path as NSString).pathExtension.lowercased()) {
                let document = try await loadImagePDF(path)
                guard let page = document.page(at: 0) else { throw BoardPrintError.unreadableSource(path) }
                let target = item.usesBoardNotesImageBounds ? item.rect : BoardExportCardLayout(item).body
                let size = page.bounds(for: .mediaBox).size
                guard target.width > 0, target.height > 0, size.width > 0, size.height > 0 else { throw BoardPrintError.invalidGeometry }
                let scale = min(target.width / size.width, target.height / size.height)
                let destination = item.usesBoardNotesImageBounds ? target : CGRect(x: target.midX - size.width * scale / 2,
                    y: target.minY, width: size.width * scale, height: size.height * scale)
                try Task.checkCancellation()
                withWorldContext(context, plan: plan) {
                    if !item.usesBoardNotesImageBounds { drawCard(item, formula: nil, context: context) }
                    drawContentPDF(page, in: destination, context: context)
                }
            } else if item.usesFormulaRendering {
                guard let latex = item.text, !latex.isEmpty else { throw BoardPrintError.unavailableFormula(item.title) }
                let image: UIImage
                do { image = try await formulaImage(item, latex: latex) }
                catch is CancellationError { throw CancellationError() }
                catch { throw BoardPrintError.unavailableFormula(item.title) }
                try Task.checkCancellation()
                withWorldContext(context, plan: plan) { drawCard(item, formula: image, context: context) }
            } else {
                if item.kind == .document {
                    guard let path = item.sourcePath else { throw BoardPrintError.missingSource(item.title) }
                    if !verifiedCards.contains(path) {
                        do {
                            let source = try await sourceStore.snapshot(relativePath: path)
                            try recordSource(source, path: path)
                        }
                        catch is CancellationError { throw CancellationError() }
                        catch { throw BoardPrintError.missingSource(path) }
                        verifiedCards.insert(path)
                    }
                }
                if item.kind != .inkGroup { try BoardExportContent.validateText(item, layout: BoardExportCardLayout(item)) }
                withWorldContext(context, plan: plan) { drawCard(item, formula: nil, context: context) }
            }
            if let value = item.url, let url = URL(string: value), Self.safeLink(url) {
                appendLink(url, worldRect: item.rect, plan: plan, to: &links)
            }
            if index % 8 == 0 { await Task.yield() }
        }
        try Task.checkCancellation()
        let relevant = ink.strokes.filter { $0.renderBounds.intersects(plan.clip) }
        if !relevant.isEmpty {
            let scale = dpi / 72 * plan.scale
            let size = CGSize(width: ceil(plan.clip.width * scale), height: ceil(plan.clip.height * scale))
            try validatePixels(size)
            // Native PKDrawing preserves pressure, ink textures, alpha and erased
            // ranges; clipping is per print page, never a bitmap of the whole world.
            let image = PKDrawing(strokes: relevant).image(from: plan.clip, scale: scale)
            withWorldContext(context, plan: plan) { image.draw(in: plan.clip) }
        }
        if !fallbackWebInk.isEmpty {
            withWorldContext(context, plan: plan) { Self.drawWebInk(fallbackWebInk, clip: plan.clip, context: context) }
        }
        if plan.footer {
            withPaperContext(context, size: plan.paper) {
                let label = String(pageNumber) as NSString
                let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 10), .foregroundColor: UIColor.black]
                let size = label.size(withAttributes: attributes)
                label.draw(at: CGPoint(x: (plan.paper.width - size.width) / 2,
                                       y: plan.paper.height - 18 - size.height / 2), withAttributes: attributes)
            }
        }
        return links
    }

    private static func visibleExportItems(_ snapshot: BoardDocument) -> [BoardItem] {
        var result = snapshot.items
        for owner in snapshot.items {
            for (index, child) in (owner.childBoards ?? []).enumerated() {
                let frame = child.presentation?.expanded == true ? child.presentation!.rect : BoardChildLayout.collapsedRect(owner: owner, index: index)
                result.append(BoardItem(kind: .text, x: frame.minX, y: frame.minY, width: frame.width, height: frame.height,
                    title: child.title, text: String(localized: "子白板引用；请进入子白板单独导出完整内容。") + "\n" + child.path))
            }
        }
        return result
    }

    static func automaticFrames(snapshot: BoardDocument, ink: PKDrawing, web: [BoardWebStroke] = []) throws -> [BoardPrintFrame] {
        try snapshot.validate()
        var bounds = visibleExportItems(snapshot).reduce(CGRect.null) { $0.union($1.rect) }
        for stroke in ink.strokes { bounds = bounds.union(stroke.renderBounds) }
        for stroke in web {
            var strokeBounds = CGRect.null
            for point in stroke.points {
                let width = point[2]
                strokeBounds = strokeBounds.union(CGRect(x: point[0] - width / 2, y: point[1] - width / 2, width: width, height: width))
            }
            if let commands = stroke.clipPath {
                let mask = try BoardWebClipPath.path(from: commands)
                strokeBounds = mask.isEmpty ? .null : strokeBounds.intersection(mask.boundingBoxOfPath)
            }
            bounds = bounds.union(strokeBounds)
        }
        guard !bounds.isNull, !bounds.isInfinite, PrintPageGeometry.valid(bounds) else { throw NoteExchangePrintError.empty }
        // The visible canvas has a fixed boundary. Never crop content silently.
        guard bounds.minX >= 0, bounds.minY >= 0, bounds.maxX <= snapshot.canvasWidth, bounds.maxY <= snapshot.canvasHeight else { throw BoardPrintError.invalidGeometry }
        let padded = bounds.insetBy(dx: -8, dy: -8).intersection(CGRect(x: 0, y: 0, width: snapshot.canvasWidth, height: snapshot.canvasHeight))
        let content = BoardPrintOrientation.portrait.contentRect.size
        guard ceil(padded.width / content.width) * ceil(padded.height / content.height) <= 200 else { throw NoteExchangePrintError.budget }
        // At a distant canvas edge, fitting the final full paper frame cannot
        // silently extend past the model boundary. Ask for a selected range.
        return try PrintPageGeometry.frames(for: padded, mode: .tile, canvasSize: snapshot.canvasWidth)
    }
    private static func validatedWebInk(_ ink: BoardWebInk?) throws -> [BoardWebStroke] {
        guard let ink else { return [] }
        guard ink.version == 1, ink.strokes.count <= 50_000 else { throw BoardPrintError.invalidDrawing }
        var count = 0, clipCount = 0
        for stroke in ink.strokes {
            count += stroke.points.count
            guard count <= 1_000_000, stroke.points.count <= 50_000,
                  stroke.opacity.isFinite, (0...1).contains(stroke.opacity), BoardStyledDrawing.color(stroke.color) != nil else { throw BoardPrintError.invalidDrawing }
            for point in stroke.points {
                guard point.count == 3, point.allSatisfy(\.isFinite), abs(point[0]) <= 8_000_000, abs(point[1]) <= 8_000_000,
                      point[2] > 0, point[2] <= 10_000 else { throw BoardPrintError.invalidDrawing }
            }
            if let commands = stroke.clipPath {
                clipCount += commands.count
                guard clipCount <= BoardWebClipPath.maximumTotalCommands else { throw BoardPrintError.invalidDrawing }
                _ = try BoardWebClipPath.path(from: commands)
            }
        }
        return ink.strokes
    }
    private static func drawWebInk(_ strokes: [BoardWebStroke], clip: CGRect, context: CGContext) {
        for stroke in strokes where !stroke.points.isEmpty {
            guard let color = BoardStyledDrawing.color(stroke.color) else { continue }
            context.saveGState()
            if let commands = stroke.clipPath {
                // validatedWebInk has already checked every command and limit.
                guard let mask = try? BoardWebClipPath.path(from: commands) else { context.restoreGState(); continue }
                context.addPath(mask); context.clip()
            }
            context.setAlpha(stroke.opacity); context.beginTransparencyLayer(auxiliaryInfo: nil)
            context.setStrokeColor(color.cgColor); context.setFillColor(color.cgColor); context.setLineCap(.round); context.setLineJoin(.round)
            for (index, point) in stroke.points.enumerated() {
                let current = CGPoint(x: point[0], y: point[1])
                if index == 0 {
                    let dot = CGRect(x: current.x - point[2] / 2, y: current.y - point[2] / 2, width: point[2], height: point[2])
                    if dot.intersects(clip) { context.fillEllipse(in: dot) }
                } else {
                    let before = stroke.points[index - 1], width = (before[2] + point[2]) / 2
                    let region = CGRect(x: min(before[0], point[0]), y: min(before[1], point[1]), width: abs(before[0] - point[0]) + 0.01, height: abs(before[1] - point[1]) + 0.01).insetBy(dx: -width, dy: -width)
                    if region.intersects(clip) {
                        context.setLineWidth(width); context.move(to: CGPoint(x: before[0], y: before[1])); context.addLine(to: current); context.strokePath()
                    }
                }
            }
            context.endTransparencyLayer(); context.restoreGState()
        }
    }

    private func loadPDF(_ path: String) async throws -> PDFDocument {
        let key = "pdf:" + path
        if let cached = pdfCache[key] {
            cacheOrder.removeAll { $0 == key }; cacheOrder.append(key)
            return cached.document
        }
        let snapshot: SourceDocumentSnapshot
        do { snapshot = try await sourceStore.snapshot(relativePath: path) }
        catch is CancellationError { throw CancellationError() }
        catch SourceDocumentRenderError.tooLarge { throw BoardPrintError.unreadableSource(path + String(localized: "（原文件超过 128 MiB 读取容量）")) }
        catch { throw BoardPrintError.missingSource(path) }
        try recordSource(snapshot, path: path)
        guard let pdf = PDFDocument(data: snapshot.data), !pdf.isLocked, pdf.pageCount > 0,
              pdf.allowsPrinting else { throw BoardPrintError.unreadableSource(path) }
        cachePDF(pdf, bytes: snapshot.data.count, key: key)
        return pdf
    }

    private func cachePDF(_ document: PDFDocument, bytes: Int, key: String) {
        while !cacheOrder.isEmpty && (cacheOrder.count >= 2 || pdfCache.values.reduce(0, { $0 + $1.bytes }) + bytes > 128 * 1_024 * 1_024) {
            pdfCache.removeValue(forKey: cacheOrder.removeFirst())
        }
        pdfCache[key] = CachedPDF(document: document, bytes: bytes); cacheOrder.append(key)
    }

    private func loadImagePDF(_ path: String) async throws -> PDFDocument {
        let key = "image:" + path
        if let cached = pdfCache[key] {
            cacheOrder.removeAll { $0 == key }; cacheOrder.append(key); return cached.document
        }
        let source: SourceDocumentSnapshot
        do { source = try await sourceStore.snapshot(relativePath: path, maximumBytes: ImageDocumentRenderer.maximumSourceBytes) }
        catch is CancellationError { throw CancellationError() }
        catch { throw BoardPrintError.unreadableSource(path) }
        try recordSource(source, path: path)
        let bytes: Data
        do { bytes = try await ImageDocumentRenderer.render(data: source.data, fileExtension: (path as NSString).pathExtension) }
        catch is CancellationError { throw CancellationError() }
        catch { throw BoardPrintError.unreadableSource(path) }
        guard let document = PDFDocument(data: bytes), document.pageCount == 1,
              let page = document.page(at: 0), PrintPageGeometry.valid(page.bounds(for: .mediaBox)) else {
            throw BoardPrintError.unreadableSource(path)
        }
        cachePDF(document, bytes: bytes.count, key: key)
        return document
    }

    private func loadRichTextPDF(_ item: BoardItem, body: CGRect) async throws -> PDFDocument {
        let key = "rich:" + item.id.uuidString
        if let cached = pdfCache[key] {
            cacheOrder.removeAll { $0 == key }; cacheOrder.append(key); return cached.document
        }
        do {
            let rendered = try await BoardExportContent.richTextPDF(item: item, body: body)
            cachePDF(rendered.document, bytes: rendered.bytes, key: key)
            return rendered.document
        } catch is CancellationError { throw CancellationError() }
        catch let error as BoardExportContentError { throw error }
        catch { throw BoardExportContentError.unavailable(item.title) }
    }

    private func recordSource(_ source: SourceDocumentSnapshot, path: String) throws {
        if let original = sourceDigests[path], original != source.sha256 {
            throw BoardPrintError.unreadableSource(path + String(localized: "（导出期间原文发生修改）"))
        }
        sourceDigests[path] = source.sha256
    }

    private func verifySources() async throws {
        for path in sourceDigests.keys.sorted() {
            try Task.checkCancellation()
            let source: SourceDocumentSnapshot
            do { source = try await sourceStore.snapshot(relativePath: path) }
            catch is CancellationError { throw CancellationError() }
            catch { throw BoardPrintError.missingSource(path) }
            try recordSource(source, path: path)
        }
    }

    private func drawContentPDF(_ page: PDFPage, in destination: CGRect, context: CGContext) {
        let source = page.bounds(for: .mediaBox)
        context.saveGState(); defer { context.restoreGState() }
        context.clip(to: destination)
        context.translateBy(x: destination.minX, y: destination.maxY)
        context.scaleBy(x: destination.width / source.width, y: -destination.height / source.height)
        context.translateBy(x: -source.minX, y: -source.minY)
        page.draw(with: .mediaBox, to: context)
    }

    private func appendContentLinks(_ page: PDFPage, destination: CGRect, plan: PagePlan, to links: inout [(CGRect, URL)]) {
        let source = page.bounds(for: .mediaBox)
        for annotation in page.annotations {
            guard let action = annotation.action as? PDFActionURL, let url = action.url, Self.safeLink(url) else { continue }
            let rect = annotation.bounds
            let world = CGRect(x: destination.minX + (rect.minX - source.minX) / source.width * destination.width,
                y: destination.minY + (source.maxY - rect.maxY) / source.height * destination.height,
                width: rect.width / source.width * destination.width, height: rect.height / source.height * destination.height)
            appendLink(url, worldRect: world.intersection(destination), plan: plan, to: &links)
        }
    }

    private func formulaImage(_ item: BoardItem, latex: String) async throws -> UIImage {
        try Task.checkCancellation()
        let wait = PrintFormulaWait()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                wait.attach(continuation)
                formulaRenderer.render(latexText: latex, fontSize: item.style?.fontSize ?? 28,
                    colorHex: item.style?.textColor ?? "#17232e", backgroundHex: item.style?.fillColor ?? "#FFFFFF") { wait.finish($0) }
            }
        } onCancel: { Task { @MainActor in wait.finish(.failure(CancellationError())) } }
    }

    private func withPaperContext(_ context: CGContext, size: CGSize, draw: () -> Void) {
        context.saveGState()
        context.translateBy(x: 0, y: size.height); context.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(context)
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent(draw)
        UIGraphicsPopContext(); context.restoreGState()
    }
    private func withWorldContext(_ context: CGContext, plan: PagePlan, draw: () -> Void) {
        withPaperContext(context, size: plan.paper) {
            context.saveGState(); defer { context.restoreGState() }
            context.clip(to: plan.destination)
            context.translateBy(x: plan.destination.minX, y: plan.destination.minY)
            context.scaleBy(x: plan.scale, y: plan.scale)
            context.translateBy(x: -plan.source.minX, y: -plan.source.minY)
            context.clip(to: plan.clip)
            draw()
        }
    }
    private func appendLink(_ url: URL, worldRect: CGRect, plan: PagePlan, to links: inout [(CGRect, URL)]) {
        let clipped = worldRect.intersection(plan.clip)
        guard PrintPageGeometry.valid(clipped) else { return }
        links.append((plan.paperRect(for: clipped), url))
    }
    private static func safeLink(_ url: URL) -> Bool {
        ["https", "http", "mailto", "obsidian", "inkspace"].contains(url.scheme?.lowercased() ?? "")
    }
    private func validatePixels(_ size: CGSize) throws {
        guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0,
              size.width <= 12_000, size.height <= 12_000, size.width * size.height <= CGFloat(maximumPixels) else {
            throw BoardPrintError.regionTooLarge
        }
    }
    private func checkOutput(_ url: URL) throws {
        guard ((try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? (maximumFileBytes + 1)) <= maximumFileBytes else {
            throw BoardPrintError.regionTooLarge
        }
    }
    private static func safeFilename(_ title: String) -> String {
        let safe = title.components(separatedBy: CharacterSet(charactersIn: "/\\:\0\n\r")).joined(separator: "-")
        return String((safe.isEmpty ? "白板导出" : safe).prefix(80))
    }

    private func drawCard(_ item: BoardItem, formula: UIImage?, context: CGContext) {
        context.saveGState(); defer { context.restoreGState() }
        if item.kind == .inkGroup { return }
        let layout = BoardExportCardLayout(item)
        let path: UIBezierPath
        switch layout.shape {
        case .ellipse: path = UIBezierPath(ovalIn: item.rect)
        case .rounded, nil: path = UIBezierPath(roundedRect: item.rect, cornerRadius: 8)
        default: path = UIBezierPath(rect: item.rect)
        }
        layout.fillColor.setFill(); path.fill()
        layout.strokeColor.setStroke(); path.lineWidth = layout.strokeWidth; path.stroke(); path.addClip()
        if !layout.styled {
            UIColor(red: 0.95, green: 0.97, blue: 0.96, alpha: 1).setFill()
            context.fill(CGRect(x: item.x, y: item.y, width: item.width, height: min(28, item.height)))
        }
        (item.title as NSString).draw(in: layout.title, withAttributes: layout.titleAttributes)
        let body = layout.body
        if let formula, body.width > 0, body.height > 0 {
            let scale = min(0.5, body.width / formula.size.width, body.height / formula.size.height)
            formula.draw(in: CGRect(x: layout.styled ? body.minX : body.midX - formula.size.width * scale / 2, y: body.minY,
                                    width: formula.size.width * scale, height: formula.size.height * scale))
        } else if !item.usesFormulaRendering && !item.usesRichTextRendering &&
                    !(item.kind == .document && ["png", "jpg", "jpeg"].contains(((item.sourcePath ?? "") as NSString).pathExtension.lowercased())) {
            let text = (item.kind == .document ? item.sourcePath : item.text) ?? ""
            (text as NSString).draw(in: body, withAttributes: layout.bodyAttributes)
        }
    }

    private func drawEdges(snapshot: BoardDocument, clip: CGRect, context: CGContext) {
        let byID = Dictionary(uniqueKeysWithValues: snapshot.items.map { ($0.id, $0) })
        context.setStrokeColor(UIColor.systemTeal.withAlphaComponent(0.72).cgColor)
        context.setLineWidth(2)
        for edge in snapshot.edges {
            guard let a = byID[edge.from]?.rect, let b = byID[edge.to]?.rect,
                  a.union(b).intersects(clip) else { continue }
            let horizontal = abs(b.midX - a.midX) >= abs(b.midY - a.midY)
            let start = horizontal ? CGPoint(x: b.midX >= a.midX ? a.maxX : a.minX, y: a.midY)
                                   : CGPoint(x: a.midX, y: b.midY >= a.midY ? a.maxY : a.minY)
            let end = horizontal ? CGPoint(x: b.midX >= a.midX ? b.minX : b.maxX, y: b.midY)
                                 : CGPoint(x: b.midX, y: b.midY >= a.midY ? b.minY : b.maxY)
            let midX = (start.x + end.x) / 2, midY = (start.y + end.y) / 2
            context.saveGState()
            BoardStyledDrawing.edgeStyle(edge, scale: 1, context: context)
            context.move(to: start)
            context.addCurve(to: end, control1: horizontal ? CGPoint(x: midX, y: start.y) : CGPoint(x: start.x, y: midY),
                             control2: horizontal ? CGPoint(x: midX, y: end.y) : CGPoint(x: end.x, y: midY))
            context.strokePath()
            context.setLineDash(phase: 0, lengths: [])
            if let arrow = edge.style?.arrow, arrow != .none {
                BoardStyledDrawing.arrow(at: end, from: horizontal ? CGPoint(x: midX, y: end.y) : CGPoint(x: end.x, y: midY), scale: 1, context: context)
                if arrow == .both { BoardStyledDrawing.arrow(at: start, from: horizontal ? CGPoint(x: midX, y: start.y) : CGPoint(x: start.x, y: midY), scale: 1, context: context) }
            }
            BoardStyledDrawing.relation(edge.relation, at: CGPoint(x: midX, y: midY), scale: 1)
            context.restoreGState()
        }
    }
}

@MainActor private final class PrintFormulaWait {
    private var continuation: CheckedContinuation<UIImage, Error>?
    private var result: Result<UIImage, Error>?
    func attach(_ continuation: CheckedContinuation<UIImage, Error>) {
        if let result { continuation.resume(with: result) } else { self.continuation = continuation }
    }
    func finish(_ result: Result<UIImage, Error>) {
        guard self.result == nil else { return }
        self.result = result
        continuation?.resume(with: result); continuation = nil
    }
}

enum NoteExchangePrintError: LocalizedError {
    case empty, budget
    var errorDescription: String? {
        switch self {
        case .empty: String(localized: "白板没有可导出的内容。")
        case .budget: String(localized: "全部内容超过本次自动分页的 200 页容量。请选择较小范围，或使用打印框分批导出；不会省略远处内容。")
        }
    }
}
