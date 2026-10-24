import UIKit
import VisionKit
import PDFKit

/// Native Live Text on the existing compositor, not a second screenshot view.
/// In reading mode the host owns viewport gestures even on Live Text hits;
/// editing mode keeps PencilKit navigation, and long presses use system handles.
@MainActor
final class BoardInlineTextSelection: NSObject, ImageAnalysisInteractionDelegate {
    private weak var content: UIView?
    private let interaction = ImageAnalysisInteraction()
    private var generation = BoardTextSelectionGeneration()
    private var worker: Task<Void, Never>?
    private var installedKey: BoardTextSelectionSnapshotKey?
    private var capturedImage: UIImage?
    private var capturedKey: BoardTextSelectionSnapshotKey?
    private var revealed = false
    private var tornDown = false
    private var status = ""
    private var nextRequestIsExplicit = false
    /// Only the board's read-aloud reuse needs to retain the input bitmap.
    /// Document fragments keep the analysis without a second owned pixel cache.
    var retainsCapturedImageForReading = false
    var capture: ((BoardTextSelectionSnapshotKey) -> UIImage?)?
    /// Board ink can render off the main thread; existing consumers retain the
    /// synchronous capture contract for already available images.
    var asyncCapture: ((BoardTextSelectionSnapshotKey) async -> UIImage?)?
    private var idleDelay: Duration = .milliseconds(450)
    var canInteract: ((CGPoint) -> Bool)?
    var onStatus: ((String) -> Void)?
    var onSelectionChanged: ((Bool) -> Void)?
    /// Optional crop placement within the existing view. Board/PDF snapshots
    /// use the whole view; a tall handwritten note analyzes only its viewport.
    var analysisContentsRect: (() -> CGRect)?

    init(content: UIView) {
        self.content = content
        super.init()
        interaction.delegate = self
        interaction.preferredInteractionTypes = []
        interaction.allowLongPressForDataDetectorsInTextMode = false
        interaction.setSupplementaryInterfaceHidden(true, animated: false)
        content.addInteraction(interaction)
    }

    var hasSelection: Bool { interaction.hasActiveTextSelection }
    var hasInstalledAnalysis: Bool { installedKey != nil }
    var selectedText: String {
        guard installedKey != nil, installedKey == generation.key, interaction.hasActiveTextSelection else { return "" }
        return interaction.selectedText
    }
    var currentStatus: String { status }
    var recognizedText: String {
        guard installedKey != nil, installedKey == generation.key, !tornDown else { return "" }
        return String((interaction.analysis?.transcript ?? "").unicodeScalars.prefix(30_000))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func update(_ key: BoardTextSelectionSnapshotKey?, idleDelay: Duration = .milliseconds(450)) {
        guard !tornDown else { return }
        let next = key.flatMap { $0.isValid ? $0 : nil }
        let delayChanged = self.idleDelay != idleDelay
        self.idleDelay = idleDelay
        let keyChanged = generation.replace(with: next)
        guard keyChanged || delayChanged else { return }
        if !keyChanged {
            generation.invalidate()
            generation.replace(with: next)
        }
        // Do not release the worker slot while ImageAnalyzer is still returning.
        // Cancellation is cooperative; this prevents overlapping scans.
        worker?.cancel()
        installedKey = nil
        capturedImage = nil; capturedKey = nil
        interaction.resetTextSelection()
        interaction.analysis = nil
        interaction.preferredInteractionTypes = []
        interaction.setContentsRectNeedsUpdate()
        if next == nil { revealed = false; nextRequestIsExplicit = false; setStatus(""); return }
        guard ImageAnalyzer.isSupported else {
            setStatus(String(localized: "此设备暂不支持白板实况文本选择。")); return
        }
        setStatus(String(localized: "停稳后可长按白板文字选择并复制。"))
        startWorkerIfNeeded()
    }

    private func startWorkerIfNeeded() {
        guard !tornDown, worker == nil, let key = generation.key, ImageAnalyzer.isSupported else { return }
        let requestGeneration = generation.value
        let explicit = nextRequestIsExplicit
        nextRequestIsExplicit = false
        worker = Task { [weak self] in
            guard let self else { return }
            defer {
                self.worker = nil
                // A replacement waits for its predecessor to fully finish.
                if !self.tornDown, self.generation.value != requestGeneration { self.startWorkerIfNeeded() }
            }
            do {
                try await Task.sleep(for: explicit ? .milliseconds(80) : self.idleDelay)
                guard self.generation.accepts(requestGeneration, key: key) else { return }
                // Acquire before taking a bitmap, so several visible fragments do
                // not each retain a large new snapshot while awaiting recognition.
                let lease = try await InlineTextAnalysis.acquire()
                defer { InlineTextAnalysis.release(lease) }
                guard self.generation.accepts(requestGeneration, key: key) else { return }
                var image: UIImage?
                for attempt in 0..<8 {
                    if attempt > 0 { try await Task.sleep(for: .milliseconds(250)) }
                    guard self.generation.accepts(requestGeneration, key: key) else { return }
                    if let asyncCapture = self.asyncCapture { image = await asyncCapture(key) }
                    else { image = self.capture?(key) }
                    try Task.checkCancellation()
                    guard self.generation.accepts(requestGeneration, key: key) else { return }
                    if image != nil { break }
                }
                guard let image, let pixels = image.cgImage,
                      pixels.width <= 4096, pixels.height <= 4096,
                      pixels.width > 0, pixels.height > 0,
                      pixels.width <= 12_000_000 / pixels.height else {
                    self.setStatus(String(localized: "请停稳画面，再点“选择文字”重试；可放大要识别的区域。"))
                    return
                }
                if self.retainsCapturedImageForReading { self.capturedImage = image; self.capturedKey = key }
                self.setStatus(String(localized: "正在本机识别当前画面文字…"))
                var configuration = ImageAnalyzer.Configuration(.text)
                configuration.locales = BoardTextRecognitionPolicy.languages(supported: ImageAnalyzer.supportedTextRecognitionLanguages)
                let analysis = try await InlineTextAnalysis.analyzer.analyze(image, configuration: configuration)
                try Task.checkCancellation()
                guard self.generation.accepts(requestGeneration, key: key), self.content?.window != nil else { return }
                self.installedKey = key
                self.interaction.analysis = analysis
                self.interaction.preferredInteractionTypes = .textSelection
                self.interaction.setContentsRectNeedsUpdate()
                self.interaction.selectableItemsHighlighted = self.revealed
                self.setStatus(analysis.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? String(localized: "当前画面未识别到文字，请放大并停稳后再试；手写和公式可能无法准确识别。")
                    : String(localized: "长按白板文字可选择并复制；拖动选区手柄调整范围。"))
            } catch is CancellationError { }
            catch {
                guard self.generation.accepts(requestGeneration, key: key) else { return }
                self.setStatus(String(localized: "当前画面文字识别失败，请移动或放大后重试。"))
            }
        }
    }

    /// Optional discoverability entry. The primary gesture remains long-press
    /// directly on the board, with UIKit's handles and copy menu.
    func revealText() -> String {
        guard !tornDown else { return status }
        revealed = true
        if installedKey == generation.key, installedKey != nil, !recognizedText.isEmpty {
            interaction.selectableItemsHighlighted = true
        } else if let key = generation.key {
            // A user request bypasses the reading idle delay. Keep the slot until
            // its cancelled predecessor finishes, then use only the newest pixels.
            generation.invalidate(); generation.replace(with: key)
            nextRequestIsExplicit = true
            worker?.cancel()
            installedKey = nil; capturedImage = nil; capturedKey = nil
            interaction.resetTextSelection(); interaction.analysis = nil
            interaction.preferredInteractionTypes = []
            setStatus(String(localized: "正在准备当前画面选字，请稍候…"))
            startWorkerIfNeeded()
        }
        return status
    }

    func imageForReading(key: BoardTextSelectionSnapshotKey) -> UIImage? {
        capturedKey == key && generation.key == key ? capturedImage : nil
    }

    @discardableResult func copySelection() -> Bool {
        guard installedKey != nil, installedKey == generation.key else { return false }
        let text = selectedText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        UIPasteboard.general.string = text
        return true
    }

    @discardableResult func copyRecognizedText() -> Bool {
        let text = recognizedText
        guard !text.isEmpty else { return false }
        UIPasteboard.general.string = text
        setStatus(String(localized: "已复制当前画面识别文字，请核对手写和公式。"))
        return true
    }

    private func setStatus(_ value: String) {
        guard value != status else { return }
        status = value
        onStatus?(value)
    }

    func contentView(for interaction: ImageAnalysisInteraction) -> UIView? { content }
    func contentsRect(for interaction: ImageAnalysisInteraction) -> CGRect {
        analysisContentsRect?() ?? generation.key?.contentsRect ?? CGRect(x: 0, y: 0, width: 1, height: 1)
    }
    func interaction(_ interaction: ImageAnalysisInteraction, shouldBeginAt point: CGPoint,
                     for interactionType: ImageAnalysisInteraction.InteractionTypes) -> Bool {
        !tornDown && installedKey != nil && installedKey == generation.key
            && (content?.bounds.contains(point) ?? false) && (canInteract?(point) ?? false)
    }
    func textSelectionDidChange(_ interaction: ImageAnalysisInteraction) {
        guard !tornDown else { return }
        let selected = installedKey != nil && installedKey == generation.key && interaction.hasActiveTextSelection
        onSelectionChanged?(selected)
        if selected {
            setStatus(String(localized: "已选中文字，可拖动手柄并使用系统菜单复制。"))
        }
    }

    func tearDown() {
        guard !tornDown else { return }
        tornDown = true
        generation.invalidate()
        worker?.cancel()
        installedKey = nil; capturedImage = nil; capturedKey = nil
        interaction.resetTextSelection()
        interaction.analysis = nil
        interaction.preferredInteractionTypes = []
        interaction.delegate = nil
        content?.removeInteraction(interaction)
        capture = nil; asyncCapture = nil; canInteract = nil; onStatus = nil; onSelectionChanged = nil; analysisContentsRect = nil
    }
}

/// One on-device Live Text request across board, PDF fragments and image readers.
/// Waiting is cancellable and bounded; a cancelled in-flight engine call keeps
/// the lease until the framework returns, preventing overlapping replacement work.
@MainActor
enum InlineTextAnalysis {
    static let analyzer = ImageAnalyzer()
    private static var active: UUID?
    private enum Failure: Error, LocalizedError {
        case busy
        var errorDescription: String? { String(localized: "文字识别仍在处理中，请稍后点“选择文字”重试。") }
    }
    static func acquire() async throws -> UUID {
        for _ in 0..<80 {
            try Task.checkCancellation()
            if active == nil { let token = UUID(); active = token; return token }
            try await Task.sleep(for: .milliseconds(75))
        }
        throw Failure.busy
    }
    static func release(_ token: UUID) { if active == token { active = nil } }
}

/// Render only the page portion visible inside an existing reader. Drawing PDF
/// vectors avoids enlarging PDFView's transient display tiles for explicit OCR.
@MainActor
enum InlinePDFTextCapture {
    static func image(page: PDFPage, pageFrame: CGRect, viewport: CGRect, scale: CGFloat,
                      annotations: ((CGContext, CGRect) -> Void)? = nil) -> UIImage? {
        let visible = pageFrame.intersection(viewport)
        let displayed = page.bounds(for: .cropBox).applying(page.transform(for: .cropBox)).standardized
        guard viewport.isFiniteCanvasRect, pageFrame.isFiniteCanvasRect, displayed.isFiniteCanvasRect,
              viewport.width > 0, viewport.height > 0, pageFrame.width > 0, pageFrame.height > 0,
              displayed.width > 0, displayed.height > 0, !visible.isNull, !visible.isEmpty,
              scale.isFinite, scale > 0 else { return nil }
        let width = ceil(viewport.width * scale), height = ceil(viewport.height * scale)
        guard width <= 4096, height <= 4096, width * height <= 12_000_000 else { return nil }
        let format = UIGraphicsImageRendererFormat(); format.scale = scale; format.opaque = true
        return UIGraphicsImageRenderer(size: viewport.size, format: format).image { renderer in
            let context = renderer.cgContext
            // A PDF can rely on the context's initial black fill for its text.
            // Keep the white paper fill outside the page's graphics state.
            context.saveGState()
            context.setFillColor(UIColor.white.cgColor)
            context.fill(CGRect(origin: .zero, size: viewport.size))
            context.restoreGState()
            context.translateBy(x: -viewport.minX, y: -viewport.minY)
            context.clip(to: visible)
            context.saveGState()
            context.translateBy(x: pageFrame.minX, y: pageFrame.maxY)
            context.scaleBy(x: pageFrame.width / displayed.width, y: -pageFrame.height / displayed.height)
            context.translateBy(x: -displayed.minX, y: -displayed.minY)
            page.draw(with: .cropBox, to: context)
            context.restoreGState()
            if let annotations {
                context.translateBy(x: pageFrame.minX, y: pageFrame.minY)
                context.scaleBy(x: pageFrame.width / displayed.width, y: pageFrame.height / displayed.height)
                annotations(context, CGRect(origin: .zero, size: displayed.size))
            }
        }
    }
}
