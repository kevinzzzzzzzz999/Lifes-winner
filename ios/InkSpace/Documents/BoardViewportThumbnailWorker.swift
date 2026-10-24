import Foundation
import UIKit
import PDFKit
import PencilKit
import ImageIO
import QuickLookThumbnailing
import Darwin

/// Cancellation belongs to a viewport request, not to the board or its files.
final class BoardPreviewCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var cancellation: (() -> Void)?
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func cancel() {
        lock.lock(); stopped = true; let action = cancellation; cancellation = nil; lock.unlock()
        action?()
    }
    func onCancel(_ action: @escaping () -> Void) {
        lock.lock(); let run = stopped; if !run { cancellation = action }; lock.unlock()
        if run { action() }
    }
}

/// A normalized, top-left page crop, rendered directly from PDF vectors.
/// Each request covers at most one small physical-pixel tile, never a whole
/// zoomed page bitmap. The geometry also preserves rotated/nonzero crop boxes.
struct BoardPDFTileRegion {
    let normalizedRect: CGRect
    let pixelSize: CGSize
}

struct BoardPreviewImage {
    let image: UIImage
    /// File identity, nanosecond modification/change times and size, read off the main thread.
    let revision: String
}

/// All PDFKit and PencilKit thumbnail work is serial and off the main thread.
/// The viewport submits at most two jobs; obsolete queued jobs exit before opening a file.
final class BoardViewportThumbnailWorker: @unchecked Sendable {
    static let shared = BoardViewportThumbnailWorker()
    private let queue = DispatchQueue(label: "InkSpace.viewport-thumbnails", qos: .userInitiated)
    private var documents: [String: PDFDocument] = [:]
    private var documentOrder: [String] = []

    func clearCache() {
        queue.async { self.documents.removeAll(); self.documentOrder.removeAll() }
    }

    func revisions(root: URL, paths: Set<String>, token: BoardPreviewCancellation,
                   completion: @escaping ([String: String]) -> Void) {
        queue.async {
            let access = root.startAccessingSecurityScopedResource()
            defer { if access { root.stopAccessingSecurityScopedResource() } }
            var result: [String: String] = [:]
            for path in paths {
                guard !token.isCancelled else { return }
                result[path] = self.safeURL(path, root: root).flatMap { self.revision($0) } ?? "unavailable"
            }
            DispatchQueue.main.async { if !token.isCancelled { completion(result) } }
        }
    }

    func image(item: BoardItem, root: URL?, owners: Set<UUID>, pixelLength: Int,
               token: BoardPreviewCancellation, region: BoardPDFTileRegion? = nil, completion: @escaping (Result<BoardPreviewImage, Error>) -> Void) {
        let length = max(16, min(1_024, pixelLength))
        queue.async {
            guard !token.isCancelled else { return }
            autoreleasepool {
                if item.kind == .inkGroup {
                    guard let data = item.inkData, let drawing = try? PKDrawing(data: data),
                          item.width.isFinite, item.height.isFinite, item.width > 0, item.height > 0 else {
                        self.finish(.failure(DocumentLibraryError.thumbnailUnavailable), token, completion); return
                    }
                    // Ink groups are placed on the board's fixed light paper.
                    // The worker must not inherit dark-mode ink inversion from
                    // the process or the thread that submitted this request.
                    var paperImage: UIImage?
                    UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
                        paperImage = drawing.image(from: CGRect(x: 0, y: 0, width: item.width, height: item.height),
                                                   scale: Double(length) / max(item.width, item.height))
                    }
                    guard let image = paperImage else {
                        self.finish(.failure(DocumentLibraryError.thumbnailUnavailable), token, completion); return
                    }
                    self.finish(.success(BoardPreviewImage(image: self.resized(image, length: length), revision: "ink")), token, completion)
                    return
                }
                guard let root, let path = item.sourcePath else {
                    self.finish(.failure(DocumentLibraryError.missingFile), token, completion); return
                }
                let access = root.startAccessingSecurityScopedResource()
                defer { if access { root.stopAccessingSecurityScopedResource() } }
                guard let url = self.safeURL(path, root: root) else {
                    self.finish(.failure(DocumentLibraryError.missingFile), token, completion); return
                }
                let coordinator = NSFileCoordinator()
                token.onCancel { coordinator.cancel() }
                var coordinationError: NSError?
                var output: Result<BoardPreviewImage, Error>?
                var quickLook: (URL, String)?
                coordinator.coordinate(readingItemAt: url, options: [.withoutChanges], error: &coordinationError) { readable in
                    guard !token.isCancelled else { return }
                    guard self.safeURL(path, root: root)?.standardizedFileURL == readable.standardizedFileURL,
                          let revision = self.revision(readable) else {
                        output = .failure(DocumentLibraryError.missingFile); return
                    }
                    if readable.pathExtension.lowercased() == "pdf" {
                        let key = "\(readable.path)|\(revision)|\(BoardPDFAnnotationOwners.cacheKey(owners))"
                        let document: PDFDocument
                        if let cached = self.documents[key] { document = cached }
                        else {
                            // Bound retained source documents independently of the bitmap cache.
                            while self.documentOrder.count >= 2 { self.documents.removeValue(forKey: self.documentOrder.removeFirst()) }
                            guard let opened = PDFDocument(url: readable) else { output = .failure(DocumentLibraryError.unreadablePDF); return }
                            self.documents[key] = opened; document = opened
                        }
                        self.documentOrder.removeAll { $0 == key }; self.documentOrder.append(key)
                        guard !document.isLocked else { output = .failure(DocumentLibraryError.lockedPDF); return }
                        let number = max(1, item.page ?? 1)
                        guard let page = document.page(at: number - 1) else { output = .failure(DocumentLibraryError.invalidPage(number)); return }
                        BoardPDFAnnotationOwners.hide(in: page, owners: owners)
                        guard !token.isCancelled else { return }
                        if let region {
                            guard let image = Self.renderPDFTile(page: page, region: region) else {
                                output = .failure(DocumentLibraryError.invalidGeometry); return
                            }
                            output = .success(BoardPreviewImage(image: image, revision: revision))
                        } else {
                            let image = page.thumbnail(of: CGSize(width: length, height: length), for: .cropBox)
                            output = .success(BoardPreviewImage(image: self.resized(image, length: length), revision: revision))
                        }
                    } else if ["png", "jpg", "jpeg"].contains(readable.pathExtension.lowercased()) {
                        // ImageIO applies EXIF orientation and downsamples before decoding a large image.
                        guard let source = CGImageSourceCreateWithURL(readable as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                                kCGImageSourceCreateThumbnailFromImageAlways: true,
                                kCGImageSourceCreateThumbnailWithTransform: true,
                                kCGImageSourceThumbnailMaxPixelSize: length,
                                kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else {
                            output = .failure(DocumentLibraryError.thumbnailUnavailable); return
                        }
                        output = .success(BoardPreviewImage(image: UIImage(cgImage: image), revision: revision))
                    } else { quickLook = (readable, revision) }
                    if self.revision(readable) != revision { output = .failure(DocumentLibraryError.cancelled); quickLook = nil }
                }
                if let (readable, revision) = quickLook, !token.isCancelled {
                    let request = QLThumbnailGenerator.Request(fileAt: readable, size: CGSize(width: length, height: length), scale: 1, representationTypes: .thumbnail)
                    token.onCancel { QLThumbnailGenerator.shared.cancel(request) }
                    // Retain an independent lease until Quick Look's asynchronous callback has finished.
                    let lease = root.startAccessingSecurityScopedResource()
                    QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, error in
                        self.queue.async {
                            defer { if lease { root.stopAccessingSecurityScopedResource() } }
                            guard !token.isCancelled else { return }
                            guard self.revision(readable) == revision else {
                                self.finish(.failure(DocumentLibraryError.cancelled), token, completion); return
                            }
                            if let image = representation?.uiImage {
                                self.finish(.success(BoardPreviewImage(image: self.resized(image, length: length), revision: revision)), token, completion)
                            } else { self.finish(.failure(error ?? DocumentLibraryError.thumbnailUnavailable), token, completion) }
                        }
                    }
                } else {
                    self.finish(output ?? .failure(coordinationError ?? DocumentLibraryError.cancelled as NSError), token, completion)
                }
            }
        }
    }

    /// Called only on the serial PDF worker (or by a synthetic rendering probe).
    /// Uses PDFKit's own crop/rotation transform, as the print exporter does.
    static func renderPDFTile(page: PDFPage, region: BoardPDFTileRegion) -> UIImage? {
        let crop = region.normalizedRect, size = region.pixelSize
        guard [crop.minX, crop.minY, crop.width, crop.height, size.width, size.height].allSatisfy({ $0.isFinite }),
              crop.minX >= 0, crop.minY >= 0, crop.maxX <= 1.000001, crop.maxY <= 1.000001,
              crop.width > 0, crop.height > 0, size.width >= 1, size.height >= 1,
              size.width <= 512, size.height <= 512 else { return nil }
        let displayed = page.bounds(for: .cropBox).applying(page.transform(for: .cropBox)).standardized
        guard displayed.width.isFinite, displayed.height.isFinite, displayed.width > 0, displayed.height > 0 else { return nil }
        let full = CGSize(width: size.width / crop.width, height: size.height / crop.height)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { renderer in
            let context = renderer.cgContext
            UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
            context.translateBy(x: -crop.minX * full.width, y: -crop.minY * full.height)
            context.translateBy(x: 0, y: full.height)
            context.scaleBy(x: full.width / displayed.width, y: -full.height / displayed.height)
            context.translateBy(x: -displayed.minX, y: -displayed.minY)
            page.draw(with: .cropBox, to: context)
        }
    }

    func resize(_ image: UIImage, pixelLength: Int, token: BoardPreviewCancellation,
                completion: @escaping (Result<BoardPreviewImage, Error>) -> Void) {
        queue.async {
            guard !token.isCancelled else { return }
            self.finish(.success(BoardPreviewImage(image: self.resized(image, length: max(16, min(1_024, pixelLength))), revision: "formula")), token, completion)
        }
    }

    private func resized(_ image: UIImage, length: Int) -> UIImage {
        let ratio = min(1, CGFloat(length) / max(1, image.size.width, image.size.height))
        let size = CGSize(width: max(1, ceil(image.size.width * ratio)), height: max(1, ceil(image.size.height * ratio)))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    private func safeURL(_ path: String, root: URL) -> URL? {
        guard let result = VaultPathResolver.resolve(relativePath: path, within: root) else { return nil }
        var part = root
        for component in path.split(separator: "/") {
            part.appendPathComponent(String(component))
            guard (try? part.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false else { return nil }
        }
        return result
    }

    private func revision(_ url: URL) -> String? {
        var info = stat()
        guard url.path.withCString({ lstat($0, &info) }) == 0,
              (info.st_mode & S_IFMT) == S_IFREG else { return nil }
        return "\(info.st_dev):\(info.st_ino):\(info.st_size):\(info.st_mtimespec.tv_sec):\(info.st_mtimespec.tv_nsec):\(info.st_ctimespec.tv_sec):\(info.st_ctimespec.tv_nsec)"
    }

    private func finish(_ result: Result<BoardPreviewImage, Error>, _ token: BoardPreviewCancellation,
                        _ completion: @escaping (Result<BoardPreviewImage, Error>) -> Void) {
        DispatchQueue.main.async { if !token.isCancelled { completion(result) } }
    }
}
