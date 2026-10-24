import SwiftUI
import VisionKit

/// Image content remains in place while UIKit supplies native text handles and
/// its Copy menu. Opening/recognizing never writes back to the source image.
struct InlineImageReadingView: View {
    let url: URL
    @State private var image: UIImage?
    @State private var error: String?
    @State private var attempt = 0
    @State private var model = ImageReadingSelectionModel()

    var body: some View {
        VStack(spacing: 0) {
            if let image {
                HStack(spacing: 12) {
                    Button(String(localized: "选择文字"), systemImage: "text.cursor") { model.reveal?() }
                        .accessibilityIdentifier("imageReading.selectText")
                    Button(String(localized: "复制所选"), systemImage: "doc.on.doc") { model.copy?() }
                        .disabled(!model.hasSelection).accessibilityIdentifier("imageReading.copy")
                    Button(String(localized: "复制画面文字"), systemImage: "doc.text") { model.copyAll?() }
                        .disabled(model.recognizedText.isEmpty).accessibilityIdentifier("imageReading.copyAll")
                    Spacer(minLength: 0)
                }.buttonStyle(.bordered).padding(12).tint(PadDesign.accent)
                ImageReadingSurface(image: image, model: model)
                    .accessibilityIdentifier("imageReading.surface")
                Text(model.status).font(.footnote).foregroundStyle(PadDesign.secondaryInk)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .accessibilityIdentifier("imageReading.status")
            } else if let error {
                VStack(spacing: 16) {
                    Image(systemName: "doc.text.viewfinder").font(.largeTitle)
                    Text(error).multilineTextAlignment(.center)
                    Button(String(localized: "重试")) { attempt += 1 }.buttonStyle(.borderedProminent)
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView(String(localized: "正在读取图片…")).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.background(PadDesign.paper).foregroundStyle(PadDesign.ink)
        .task(id: "\(url.absoluteString)#\(attempt)") {
            image = nil; error = nil
            do {
                let decoded = try await LocalOCR.imageForSelection(url: url)
                try Task.checkCancellation()
                image = UIImage(cgImage: decoded)
            } catch is CancellationError { }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}

@MainActor @Observable
final class ImageReadingSelectionModel {
    var status = String(localized: "正在本机识别图片文字…")
    var hasSelection = false
    var recognizedText = ""
    @ObservationIgnored var owner: UUID?
    @ObservationIgnored var copyAll: (() -> Void)?
    @ObservationIgnored var reveal: (() -> Void)?
    @ObservationIgnored var copy: (() -> Void)?
}

struct ImageReadingSurface: UIViewControllerRepresentable {
    let image: UIImage
    let model: ImageReadingSelectionModel
    var embedded = false
    var allowsTextSelection = true
    func makeUIViewController(context: Context) -> ImageReadingController {
        ImageReadingController(image: image, model: model, embedded: embedded, allowsTextSelection: allowsTextSelection)
    }
    func updateUIViewController(_ controller: ImageReadingController, context: Context) {
        controller.setImage(image)
        controller.setSelectionEnabled(allowsTextSelection)
    }
    static func dismantleUIViewController(_ controller: ImageReadingController, coordinator: ()) { controller.stop() }
}

@MainActor
final class ImageReadingController: UIViewController, UIScrollViewDelegate, ImageAnalysisInteractionDelegate {
    let scroll = UIScrollView()
    let imageView: UIImageView
    let interaction = ImageAnalysisInteraction()
    let model: ImageReadingSelectionModel
    var task: Task<Void, Never>?
    private var lastSize = CGSize.zero
    private var fit: CGFloat = 1
    private var stopped = false
    private let embedded: Bool
    private var allowsTextSelection: Bool
    private let identity = UUID()
    private var imageGeneration = UUID()
    private var workerID: UUID?
    private var selectionScrollMinimum: Int?
    private enum RecognitionState { case idle, loading, ready, empty, unsupported, failed }
    private var recognitionState = RecognitionState.idle
    private let selectionScrollLease = InlineTextSelectionScrollLease()
    // Opt-in metadata for a real-device gesture investigation. This observes the
    // existing scroll recognizer without changing its delegate or zoom behavior.
    private struct ZoomDiagnostics {
        let instance = String(UUID().uuidString.prefix(8))
        var layouts = 0
        var resizedLayouts = 0
        var begins = 0
        var changes = 0
        var ends = 0
        var pinchEvents = 0
        var lastPinchState = "none"
        var lastPinchScale: CGFloat = 1
        var peakRelativeZoom: CGFloat = 1
    }
    private var zoomDiagnostics: ZoomDiagnostics? = ProcessInfo.processInfo.environment["INKSPACE_IMAGE_ZOOM_DIAGNOSTICS"] == "1" ? ZoomDiagnostics() : nil
    private weak var observedPinch: UIPinchGestureRecognizer?

    init(image: UIImage, model: ImageReadingSelectionModel, embedded: Bool = false, allowsTextSelection: Bool = true) {
        self.imageView = UIImageView(image: image); self.model = model
        self.embedded = embedded; self.allowsTextSelection = allowsTextSelection
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = embedded ? .clear : UIColor(PadDesign.paper)
        scroll.delegate = self; scroll.clipsToBounds = true
        scroll.isScrollEnabled = !embedded
        if embedded { scroll.pinchGestureRecognizer?.isEnabled = false }
        scroll.accessibilityIdentifier = "imageReading.zoom"
        view.addSubview(scroll)
        imageView.frame = CGRect(origin: .zero, size: imageView.image!.size)
        imageView.contentMode = .scaleAspectFit; imageView.isUserInteractionEnabled = true
        scroll.addSubview(imageView); scroll.contentSize = imageView.bounds.size
        interaction.delegate = self
        interaction.preferredInteractionTypes = []
        interaction.allowLongPressForDataDetectorsInTextMode = false
        imageView.addInteraction(interaction)
        model.owner = identity
        model.hasSelection = false; model.recognizedText = ""
        model.reveal = { [weak self] in
            guard let self, !self.stopped, self.allowsTextSelection else { return }
            if self.interaction.analysis == nil || self.recognitionState == .empty || self.recognitionState == .failed {
                self.recognitionState = .idle; self.startAnalysisIfNeeded()
            } else { self.interaction.selectableItemsHighlighted = true }
        }
        model.copy = { [weak self] in
            guard let self, !self.stopped, self.model.owner == self.identity, self.allowsTextSelection, self.interaction.hasActiveTextSelection else { return }
            let text = self.interaction.selectedText
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            UIPasteboard.general.string = text
            self.model.status = String(localized: "已复制所选文字。")
        }
        model.copyAll = { [weak self] in
            guard let self, !self.stopped, self.model.owner == self.identity,
                  self.allowsTextSelection, !self.model.recognizedText.isEmpty else { return }
            UIPasteboard.general.string = self.model.recognizedText
            self.model.status = String(localized: "已复制画面文字，请核对手写和公式。")
        }
        startAnalysisIfNeeded()
        updateSelectionStatus()
    }
    func setImage(_ image: UIImage) {
        guard imageView.image !== image else { return }
        imageGeneration = UUID()
        task?.cancel()
        interaction.resetTextSelection(); interaction.analysis = nil
        interaction.preferredInteractionTypes = []
        // A zoomed image view has a transform. Reset the scroll view before
        // assigning its frame, then let layout fit the replacement image.
        scroll.minimumZoomScale = min(scroll.minimumZoomScale, 1)
        scroll.maximumZoomScale = max(scroll.maximumZoomScale, 1)
        scroll.setZoomScale(1, animated: false)
        imageView.image = image
        imageView.frame = CGRect(origin: .zero, size: image.size)
        scroll.contentSize = image.size
        lastSize = .zero
        recognitionState = .idle
        if model.owner == identity { model.hasSelection = false; model.recognizedText = "" }
        restoreParentNavigation()
        if isViewLoaded { view.setNeedsLayout(); startAnalysisIfNeeded(); updateSelectionStatus() }
    }
    private func startAnalysisIfNeeded() {
        guard !stopped, isViewLoaded, allowsTextSelection, model.owner == identity,
              task == nil, recognitionState == .idle, let image = imageView.image else { return }
        guard ImageAnalyzer.isSupported else {
            recognitionState = .unsupported; updateSelectionStatus(); return
        }
        recognitionState = .loading
        let token = imageGeneration
        workerID = token
        task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.workerID == token {
                    self.task = nil; self.workerID = nil
                    if !self.stopped, self.recognitionState == .idle { self.startAnalysisIfNeeded() }
                }
            }
            do {
                let lease = try await InlineTextAnalysis.acquire()
                defer { InlineTextAnalysis.release(lease) }
                try Task.checkCancellation()
                guard !self.stopped, self.allowsTextSelection, self.imageGeneration == token,
                      self.model.owner == self.identity else { return }
                var config = ImageAnalyzer.Configuration(.text)
                config.locales = BoardTextRecognitionPolicy.languages(supported: ImageAnalyzer.supportedTextRecognitionLanguages)
                let result = try await InlineTextAnalysis.analyzer.analyze(image, configuration: config)
                try Task.checkCancellation()
                guard !self.stopped, self.allowsTextSelection, self.imageGeneration == token,
                      self.model.owner == self.identity else { return }
                self.interaction.analysis = result
                self.interaction.preferredInteractionTypes = .textSelection
                self.model.recognizedText = String(result.transcript.unicodeScalars.prefix(30_000))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                self.recognitionState = self.model.recognizedText.isEmpty ? .empty : .ready
                self.updateSelectionStatus()
            } catch is CancellationError { }
            catch {
                guard !self.stopped, self.imageGeneration == token, self.model.owner == self.identity else { return }
                self.recognitionState = .failed; self.updateSelectionStatus()
            }
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        zoomDiagnostics?.layouts += 1
        defer { updateZoomDiagnostics() }
        guard view.bounds.size != lastSize, let image = imageView.image,
              view.bounds.width > 0, view.bounds.height > 0 else { return }
        zoomDiagnostics?.resizedLayouts += 1
        let ratio = embedded || lastSize == .zero ? 1 : scroll.zoomScale / fit
        scroll.frame = view.bounds
        fit = min(view.bounds.width / image.size.width, view.bounds.height / image.size.height)
        scroll.minimumZoomScale = fit; scroll.maximumZoomScale = embedded ? fit : max(fit * 8, 1)
        observeExistingPinchIfNeeded()
        scroll.setZoomScale(min(scroll.maximumZoomScale, max(fit, fit * ratio)), animated: false)
        lastSize = view.bounds.size; updateZoomPresentation()
    }
    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        zoomDiagnostics?.begins += 1
        updateZoomDiagnostics()
    }
    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        zoomDiagnostics?.changes += 1
        updateZoomPresentation()
    }
    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        zoomDiagnostics?.ends += 1
        updateZoomPresentation()
    }
    private func updateZoomPresentation() {
        centerImage()
        interaction.setContentsRectNeedsUpdate()
        // Announce the visible magnification relative to the fitted image.
        // This value follows UIScrollView's actual scale, not the requested gesture.
        guard fit > 0 else { return }
        scroll.accessibilityValue = Double(scroll.zoomScale / fit).formatted(.percent.precision(.fractionLength(0)))
        updateZoomDiagnostics()
    }
    private func observeExistingPinchIfNeeded() {
        guard zoomDiagnostics != nil, let pinch = scroll.pinchGestureRecognizer, observedPinch !== pinch else { return }
        observedPinch?.removeTarget(self, action: #selector(observePinch(_:)))
        observedPinch = pinch
        pinch.addTarget(self, action: #selector(observePinch(_:)))
    }
    @objc private func observePinch(_ pinch: UIPinchGestureRecognizer) {
        guard zoomDiagnostics != nil else { return }
        zoomDiagnostics?.pinchEvents += 1
        zoomDiagnostics?.lastPinchState = String(pinch.state.rawValue)
        zoomDiagnostics?.lastPinchScale = pinch.scale
        updateZoomDiagnostics()
    }
    private func updateZoomDiagnostics() {
        guard var diagnostics = zoomDiagnostics, fit > 0 else { return }
        diagnostics.peakRelativeZoom = max(diagnostics.peakRelativeZoom, scroll.zoomScale / fit)
        zoomDiagnostics = diagnostics
        let pinch = scroll.pinchGestureRecognizer
        func number(_ value: CGFloat) -> String { String(format: "%.3f", Double(value)) }
        let detail = "zoom-test id=\(diagnostics.instance) z=\(number(scroll.zoomScale)) min=\(number(scroll.minimumZoomScale)) max=\(number(scroll.maximumZoomScale)) fit=\(number(fit)) peak=\(number(diagnostics.peakRelativeZoom)) scroll=\(scroll.isScrollEnabled) pinch=\(pinch?.isEnabled == true) state=\(pinch?.state.rawValue ?? -1) observed=\(observedPinch != nil) last=\(diagnostics.lastPinchState)/\(number(diagnostics.lastPinchScale)) events=\(diagnostics.pinchEvents) zoomCallbacks=\(diagnostics.begins)/\(diagnostics.changes)/\(diagnostics.ends) layouts=\(diagnostics.layouts)/\(diagnostics.resizedLayouts) bounds=\(number(scroll.bounds.width))x\(number(scroll.bounds.height)) selection=\(allowsTextSelection)/\(interaction.hasActiveTextSelection) panTouches=\(scroll.panGestureRecognizer.minimumNumberOfTouches)"
        scroll.accessibilityHint = detail
        // XCTest exposes value publicly, but not accessibilityHint. Ordinary
        // launches retain only the localized percentage set above.
        let percent = Double(scroll.zoomScale / fit).formatted(.percent.precision(.fractionLength(0)))
        scroll.accessibilityValue = "\(percent); \(detail)"
    }
    private func centerImage() {
        let size = scroll.bounds.size, content = scroll.contentSize
        scroll.contentInset = UIEdgeInsets(top: max(0, (size.height-content.height)/2), left: max(0, (size.width-content.width)/2), bottom: 0, right: 0)
    }
    func textSelectionDidChange(_ interaction: ImageAnalysisInteraction) {
        guard !stopped, model.owner == identity else { return }
        model.hasSelection = allowsTextSelection && interaction.hasActiveTextSelection
        if model.hasSelection {
            if selectionScrollMinimum == nil { selectionScrollMinimum = scroll.panGestureRecognizer.minimumNumberOfTouches }
            scroll.panGestureRecognizer.minimumNumberOfTouches = max(2, selectionScrollMinimum ?? 1)
        } else { restoreParentNavigation() }
        if embedded { selectionScrollLease.update(selected: model.hasSelection, ancestorsOf: view) }
        updateSelectionStatus()
        updateZoomDiagnostics()
    }
    func interaction(_ interaction: ImageAnalysisInteraction, shouldBeginAt point: CGPoint,
                     for interactionType: ImageAnalysisInteraction.InteractionTypes) -> Bool {
        guard !stopped, allowsTextSelection else { return false }
        guard embedded else { return true }
        var ancestor = view.superview
        while let current = ancestor {
            if let parent = current as? UIScrollView, parent.isDragging || parent.isDecelerating || parent.isZooming { return false }
            if (current.gestureRecognizers ?? []).contains(where: { $0 is UIPinchGestureRecognizer && ($0.state == .began || $0.state == .changed) }) { return false }
            ancestor = current.superview
        }
        return true
    }
    func setSelectionEnabled(_ enabled: Bool) {
        guard allowsTextSelection != enabled else { return }
        allowsTextSelection = enabled
        if !enabled {
            task?.cancel()
            if recognitionState == .loading { recognitionState = .idle }
            interaction.resetTextSelection()
            if model.owner == identity { model.hasSelection = false }
            restoreParentNavigation()
        } else { startAnalysisIfNeeded() }
        interaction.preferredInteractionTypes = enabled && interaction.analysis != nil ? .textSelection : []
        updateSelectionStatus()
        updateZoomDiagnostics()
    }
    private func updateSelectionStatus() {
        guard !stopped, model.owner == identity else { return }
        // Recognition failures and empty images must not become a success hint
        // merely because selection ended or the app moved to the background.
        switch recognitionState {
        case .idle: model.status = String(localized: "点“选择文字”可在图片上选字并复制。")
        case .loading: model.status = String(localized: "正在本机识别图片文字…")
        case .empty: model.status = String(localized: "未识别到文字，请检查图片清晰度；手写和公式请核对。")
        case .unsupported: model.status = String(localized: "此设备暂不支持原位选字，可使用本机文字识别。")
        case .failed: model.status = String(localized: "文字识别未完成，请关闭图片后重试。")
        case .ready:
            if model.hasSelection {
                model.status = String(localized: "拖动手柄调整范围，然后复制；双指可继续移动图片。")
            } else if !allowsTextSelection {
                model.status = embedded
                    ? String(localized: "已结束选字，可继续阅读。")
                    : String(localized: "可缩放、移动图片；点“选择文字”后可选字。")
            } else {
                model.status = String(localized: "长按文字选择并复制；双指可缩放图片。")
            }
        }
    }
    private func restoreParentNavigation() {
        if let minimum = selectionScrollMinimum {
            scroll.panGestureRecognizer.minimumNumberOfTouches = minimum
            selectionScrollMinimum = nil
        }
        selectionScrollLease.release()
    }
    func stop() {
        stopped = true; task?.cancel(); task = nil
        observedPinch?.removeTarget(self, action: #selector(observePinch(_:)))
        observedPinch = nil
        interaction.resetTextSelection(); interaction.analysis = nil; interaction.delegate = nil
        restoreParentNavigation()
        if model.owner == identity {
            model.owner = nil; model.reveal = nil; model.copy = nil; model.copyAll = nil
            model.hasSelection = false; model.recognizedText = ""
        }
    }
}

/// Adjacent fragments/images can briefly own selections at the same time.
/// Share a lease so clearing either one cannot strand the parent at two fingers.
@MainActor final class InlineTextSelectionScrollLease {
    @MainActor private final class Entry {
        weak var scroll: UIScrollView?
        let minimum: Int
        var owners = Set<UUID>()
        init(_ scroll: UIScrollView) { self.scroll = scroll; minimum = scroll.panGestureRecognizer.minimumNumberOfTouches }
    }
    private static var entries: [ObjectIdentifier: Entry] = [:]
    private let owner = UUID()
    private var held = Set<ObjectIdentifier>()
    func update(selected: Bool, ancestorsOf view: UIView) {
        guard selected else { release(); return }
        var ancestor = view.superview
        while let current = ancestor {
            if let scroll = current as? UIScrollView {
                let id = ObjectIdentifier(scroll)
                let entry = Self.entries[id] ?? Entry(scroll)
                Self.entries[id] = entry; entry.owners.insert(owner); held.insert(id)
                scroll.panGestureRecognizer.minimumNumberOfTouches = max(2, entry.minimum)
            }
            ancestor = current.superview
        }
    }
    func release() {
        for id in held {
            guard let entry = Self.entries[id] else { continue }
            entry.owners.remove(owner)
            if entry.owners.isEmpty {
                entry.scroll?.panGestureRecognizer.minimumNumberOfTouches = entry.minimum
                Self.entries.removeValue(forKey: id)
            }
        }
        held.removeAll()
    }
}
