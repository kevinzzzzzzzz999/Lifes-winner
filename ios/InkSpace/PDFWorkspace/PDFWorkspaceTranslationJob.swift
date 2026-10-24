import Foundation
import Observation
import PDFKit
import UIKit

private final class PDFWorkspacePageRenderer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "InkSpace.pdf-translation-pages", qos: .userInitiated)
    private let data: Data
    private var document: PDFDocument?
    init(data: Data) { self.data = data }
    func render(page number: Int) async throws -> Data {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result {
                    if self.document == nil { self.document = PDFDocument(data: self.data) }
                    guard let document = self.document, !document.isLocked, let page = document.page(at: number - 1) else { throw PDFWorkspaceError.unavailable }
                    let box = page.bounds(for: .cropBox)
                    let rotated = abs(page.rotation % 180) == 90
                    let size = rotated ? CGSize(width: box.height, height: box.width) : box.size
                    guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { throw PDFWorkspaceError.unavailable }
                    let factor = 1600 / max(size.width, size.height)
                    let target = CGSize(width: size.width * factor, height: size.height * factor)
                    let image = page.thumbnail(of: target, for: .cropBox)
                    guard let png = image.pngData(), png.count <= 4 * 1024 * 1024 else { throw PDFTranslationError.invalidImage }
                    return png
                })
            }
        }
    }
}

@MainActor @Observable final class PDFWorkspaceTranslationJob {
    static let maximumPages = 2000
    static let maximumTextScalars = 2_000_000
    static let maximumPageScalars = 60000
    private(set) var sourceSHA256 = ""
    private(set) var pages: [PDFWorkspaceTranslatedPage] = []
    private(set) var range: ClosedRange<Int> = 1...1
    private(set) var provider = PDFTranslationProvider.openAI
    private(set) var model = ""
    private(set) var language = ""
    private(set) var status = "idle"
    private(set) var error = ""
    private(set) var isRunning = false
    @ObservationIgnored private var runID: UUID?
    @ObservationIgnored private var task: Task<Void,Never>?
    @ObservationIgnored private let client: PDFTranslationClient
    @ObservationIgnored private let readKey: (PDFTranslationProvider) throws -> String
    init(client: PDFTranslationClient = PDFTranslationClient(), readKey: @escaping (PDFTranslationProvider) throws -> String = { try PDFTranslationKeyStore.read($0) }) {
        self.client = client; self.readKey = readKey
    }
    /// Only this explicit Start call can incur an API request. Every page is a
    /// bounded immutable source snapshot; completed sections survive cancellation.
    func start(repository: PDFWorkspaceRepository, sourceSHA256: String, range: ClosedRange<Int>, pageCount: Int,
               provider: PDFTranslationProvider, model: String, language: String) {
        guard !isRunning else { return }
        guard range.lowerBound >= 1, range.upperBound <= pageCount, range.count <= Self.maximumPages else {
            error = String(localized: "请选择有效页码范围，每次最多翻译 2000 页。"); return
        }
        self.sourceSHA256 = sourceSHA256
        self.range = range; self.provider = provider; self.model = model; self.language = language
        pages = []; error = ""; isRunning = true; status = "running"
        let id = UUID(); runID = id
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let key = try PDFTranslationInput.key(readKey(provider))
                let data = try await repository.readPDF(expectedSHA256: sourceSHA256)
                try Task.checkCancellation()
                let renderer = PDFWorkspacePageRenderer(data: data)
                var scalarCount = 0
                for page in range {
                    try Task.checkCancellation(); guard runID == id else { return }
                    // Reserve a whole maximum-size response before incurring cost.
                    guard Self.maximumTextScalars - scalarCount >= Self.maximumPageScalars else { status = "capacity"; break }
                    try await repository.validateSource(expectedSHA256: sourceSHA256)
                    let png = try await renderer.render(page: page)
                    try Task.checkCancellation()
                    let text = try await client.translate(png: png, provider: provider, model: model, language: language, apiKey: key, purpose: .page)
                    try Task.checkCancellation(); guard runID == id else { return }
                    try await repository.validateSource(expectedSHA256: sourceSHA256)
                    try Task.checkCancellation(); guard runID == id else { return }
                    let count = text.unicodeScalars.count
                    guard count <= Self.maximumPageScalars, scalarCount + count <= Self.maximumTextScalars else { throw PDFTranslationError.invalidResponse }
                    scalarCount += count; pages.append(PDFWorkspaceTranslatedPage(page: page, text: text))
                }
                guard runID == id else { return }
                if status == "running" { status = pages.count == range.count ? "complete" : "failed" }
                isRunning = false; task = nil
            } catch is CancellationError {
                if runID == id { status = "cancelled"; isRunning = false; task = nil }
            } catch {
                guard runID == id else { return }
                self.error = error.localizedDescription; status = "failed"; isRunning = false; task = nil
            }
        }
    }
    func cancel() {
        guard isRunning else { return }
        task?.cancel(); task = nil; runID = nil; isRunning = false; status = "cancelled"
    }
}
