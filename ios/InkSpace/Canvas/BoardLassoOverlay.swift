import UIKit

/// Presentation only: the host owns selection, transforms, undo, and persistence.
/// All callback points and rectangles use this view's local screen coordinates.
@MainActor final class BoardLassoOverlay: UIView, UIGestureRecognizerDelegate {
    enum Corner: String, CaseIterable { case topLeft, topRight, bottomLeft, bottomRight }
    enum TransformKind: Equatable { case move, resize(Corner) }

    static let allTypes: Set<String> = ["ink", "document", "video", "image", "text"]
    var onBeginPath: (() -> Void)?
    var onSelectPath: (([CGPoint]) -> Void)?
    var onBeginTransform: ((TransformKind, CGPoint) -> Void)?
    var onUpdateTransform: ((CGPoint) -> Void)?
    var onEndTransform: ((_ cancelled: Bool) -> Void)?
    var onScale: ((CGFloat) -> Void)?
    var onSelectVisible: (() -> Void)?
    var onDuplicateSelection: (() -> Void)?
    var onCopySelection: (() -> Void)?
    var onPasteSelection: (() -> Void)?
    var onTypesChanged: ((Set<String>) -> Void)?
    var onClearSelection: (() -> Void)?
    var onClose: (() -> Void)?
    var onNativeLasso: (() -> Void)?
    var onInteractionChanged: ((Bool) -> Void)?
    /// Extra spacing below the safe area; the host can avoid a top-docked palette.
    var toolbarTopInset: CGFloat = 0 { didSet { setNeedsLayout() } }
    private(set) var isInteracting = false
    private(set) var selectionRect: CGRect?
    private(set) var selectionOutline: [CGPoint]?
    private var selectionShapePath: CGPath?
    private var selectionCoveragePath: CGPath?
    private var selectionBoundaryHitPath: CGPath?
    private var coverageReferenceOutline: [CGPoint]?
    private var coverageReferencePath: CGPath?
    private(set) var selectedTypes = BoardLassoOverlay.allTypes
    /// Semantic world-space state supplied by the host, independent of viewport.
    var selectionAccessibilityValue = "none" {
        didSet { selectionBody.accessibilityValue = selectionAccessibilityValue }
    }

    private let toolbar = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let summary = UILabel()
    private let typesButton = UIButton(type: .system)
    private let visibleButton = UIButton(type: .system)
    private let smallerButton = UIButton(type: .system)
    private let largerButton = UIButton(type: .system)
    private let moreButton = UIButton(type: .system)
    private let copyButton = UIButton(type: .system)
    private let doneButton = UIButton(type: .system)
    private let resizeButton = UIButton(type: .system)
    private let selectionBody = UIView()
    private var handles: [Corner: UIView] = [:]
    private var activeTransform: TransformKind?
    private var pendingTransform: (kind: TransformKind, start: CGPoint, offset: CGVector)?
    private var transformPointOffset = CGVector.zero
    private weak var transformTouch: UITouch?
    private var resizeEmphasized = false
    private var selectionText = ""
    private var pathPoints: [CGPoint] = []
    private var acceptingInput = true
    private var isWorking = false
    private var activePath = false
    private weak var pencilInputHost: UIView?
    private var canReceivePencil: ((UITouch) -> Bool)?
    private lazy var transformPan = UIPanGestureRecognizer(target: self, action: #selector(transformChanged(_:)))
    private lazy var pencilPath = BoardLassoPencilPathGesture(target: self, action: #selector(pathChanged(_:)))

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isMultipleTouchEnabled = true
        accessibilityIdentifier = "lasso.overlay"
        selectionBody.backgroundColor = .clear
        selectionBody.isAccessibilityElement = true
        selectionBody.accessibilityIdentifier = "lasso.selection"
        selectionBody.accessibilityLabel = String(localized: "圈选内容")
        selectionBody.accessibilityHint = String(localized: "单指拖动选区，拖动四角等比缩放；双指缩放白板。")
        addSubview(selectionBody)
        for corner in Corner.allCases {
            let handle = UIView()
            handle.backgroundColor = .clear
            handle.isAccessibilityElement = true
            handle.accessibilityIdentifier = "lasso.handle." + corner.rawValue
            handle.accessibilityLabel = Self.title(for: corner)
            handle.accessibilityHint = String(localized: "拖动以等比缩放选区")
            let dot = UIView(frame: CGRect(x: 14, y: 14, width: 16, height: 16))
            dot.isUserInteractionEnabled = false
            dot.backgroundColor = .systemBackground
            dot.layer.cornerRadius = 8
            dot.layer.borderWidth = 2
            dot.layer.borderColor = UIColor.systemTeal.cgColor
            handle.addSubview(dot)
            handles[corner] = handle
            addSubview(handle)
        }
        toolbar.layer.cornerRadius = 14
        toolbar.clipsToBounds = true
        toolbar.accessibilityIdentifier = "lasso.toolbar"
        addSubview(toolbar)
        configure(typesButton, symbol: "line.3.horizontal.decrease.circle", title: String(localized: "圈选内容类型"), id: "lasso.types")
        configure(visibleButton, symbol: "viewfinder", title: String(localized: "选择可见内容"), id: "lasso.selectVisible")
        configure(smallerButton, symbol: "minus.magnifyingglass", title: String(localized: "缩小选区"), id: "lasso.scaleDown")
        configure(largerButton, symbol: "plus.magnifyingglass", title: String(localized: "放大选区"), id: "lasso.scaleUp")
        configure(copyButton, symbol: "doc.on.doc", title: String(localized: "复制圈选内容"), id: "lasso.copyMenu")
        copyButton.showsMenuAsPrimaryAction = true
        configure(moreButton, symbol: "ellipsis.circle", title: String(localized: "圈选操作"), id: "lasso.more")
        configure(doneButton, symbol: "checkmark", title: String(localized: "完成圈选"), id: "lasso.done")
        var resizeConfiguration = UIButton.Configuration.filled()
        resizeConfiguration.title = String(localized: "调整大小")
        resizeConfiguration.image = UIImage(systemName: "arrow.up.left.and.arrow.down.right")
        resizeConfiguration.imagePadding = 6
        resizeConfiguration.baseBackgroundColor = .systemTeal
        resizeConfiguration.baseForegroundColor = .white
        resizeConfiguration.cornerStyle = .capsule
        resizeConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)
        resizeConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var attributes = attributes
            attributes.font = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .callout).pointSize, weight: .semibold)
            return attributes
        }
        resizeButton.configuration = resizeConfiguration
        resizeButton.accessibilityIdentifier = "lasso.resize"
        resizeButton.accessibilityLabel = String(localized: "调整大小")
        resizeButton.accessibilityHint = String(localized: "直接拖动这个按钮，或轻点后拖动选区四角。")
        resizeButton.addAction(UIAction { [weak self] _ in
            guard let self, self.acceptingInput, self.selectionRect != nil, !self.isInteracting else { return }
            self.setResizeEmphasized(true)
        }, for: .touchUpInside)
        addSubview(resizeButton)
        typesButton.showsMenuAsPrimaryAction = true
        moreButton.showsMenuAsPrimaryAction = true
        visibleButton.addAction(UIAction { [weak self] _ in self?.performIdle { $0.onSelectVisible?() } }, for: .touchUpInside)
        smallerButton.addAction(UIAction { [weak self] _ in self?.performIdle { $0.onScale?(0.8) } }, for: .touchUpInside)
        largerButton.addAction(UIAction { [weak self] _ in self?.performIdle { $0.onScale?(1.25) } }, for: .touchUpInside)
        doneButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        summary.font = .preferredFont(forTextStyle: .caption1)
        summary.textColor = .secondaryLabel
        summary.textAlignment = .center
        summary.numberOfLines = 1
        summary.lineBreakMode = .byTruncatingTail
        summary.accessibilityIdentifier = "lasso.summary"
        toolbar.contentView.addSubview(summary)
        transformPan.minimumNumberOfTouches = 1
        transformPan.maximumNumberOfTouches = 1
        transformPan.delegate = self
        transformPan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        addGestureRecognizer(transformPan)
        pencilPath.delegate = self
        pencilPath.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        update(selectionRect: nil, selectionText: String(localized: "用 Apple Pencil 圈选内容"), selectedTypes: Self.allTypes)
    }

    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    /// Observe actual Pencil touches at the common canvas ancestor. Hit testing
    /// stays geometric and never needs a populated UIEvent.allTouches set.
    /// The host supplies a current-session predicate and its allowed view tree.
    func attachPencilInput(to host: UIView, canReceive: @escaping (UITouch) -> Bool) {
        guard self !== host, isDescendant(of: host) else { detachPencilInput(); return }
        if pencilInputHost === host, pencilPath.view === host {
            canReceivePencil = canReceive
            return
        }
        detachPencilInput()
        pencilInputHost = host
        canReceivePencil = canReceive
        pencilPath.coordinateView = self
        host.addGestureRecognizer(pencilPath)
    }

    func detachPencilInput() {
        cancelInteraction()
        pencilPath.view?.removeGestureRecognizer(pencilPath)
        pencilPath.coordinateView = nil
        pencilInputHost = nil
        canReceivePencil = nil
    }

    /// Routine host synchronization never replaces the in-progress preview.
    func update(selectionRect: CGRect?, selectionOutline: [CGPoint]? = nil, selectionText: String, selectedTypes: Set<String>, isEnabled: Bool = true, isWorking: Bool = false) {
        self.isWorking = isWorking
        if !isEnabled { cancelInteraction() }
        acceptingInput = isEnabled
        self.selectedTypes = selectedTypes.intersection(Self.allTypes)
        if activeTransform == nil { setSelectionShape(rect: selectionRect, outline: selectionOutline) }
        self.selectionText = selectionText
        if self.selectionRect == nil || !isEnabled { setResizeEmphasized(false) }
        else if !resizeEmphasized, !activePath { setResizeEmphasized(true) }
        if activeTransform == nil { summary.text = selectionText } // Host errors take priority over the resize hint.
        refreshControls()
        setNeedsLayout()
        setNeedsDisplay()
    }

    /// The host projects its immutable transaction's preview into screen space.
    /// No drawing or board data is changed by this component.
    func updatePreview(selectionRect: CGRect?, selectionOutline: [CGPoint]? = nil, selectionText: String? = nil) {
        setSelectionShape(rect: selectionRect, outline: selectionOutline)
        if let selectionText {
            summary.text = selectionText
        }
        setNeedsLayout()
        setNeedsDisplay()
    }

    /// Call before a host pinch starts, on mode/session changes, and at teardown.
    /// A second finger belongs to the ancestor's viewport gesture, never to a
    /// synthetic touch forwarded into the sibling PKCanvasView.
    func cancelInteraction() {
        pendingTransform = nil
        transformTouch = nil
        transformPointOffset = .zero
        let hadTransform = activeTransform != nil
        activeTransform = nil
        activePath = false
        pathPoints = []
        if hadTransform { onEndTransform?(true) }
        setInteracting(false)
        for gesture in [transformPan as UIGestureRecognizer, pencilPath] {
            gesture.isEnabled = false
            gesture.isEnabled = true
        }
        setNeedsDisplay()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { cancelInteraction(); setResizeEmphasized(false) }
    }

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        if let host = pencilInputHost, !isDescendant(of: host) { detachPencilInput() }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, alpha > 0.01, isUserInteractionEnabled, bounds.contains(point) else { return nil }
        if toolbar.frame.contains(point) {
            return toolbar.hitTest(convert(point, to: toolbar), with: event)
        }
        guard acceptingInput else { return nil }
        if isResizeButtonPoint(point) { return resizeButton }
        if let corner = corner(at: point), let handle = handles[corner], !handle.isHidden { return handle }
        if !selectionBody.isHidden, selectionContains(point) { return selectionBody }
        // Fingers and Pencil share the same geometric hit test. The ancestor's
        // Pencil-only recognizer receives the real touch and filters its type;
        // fingers continue to the underlying canvas for scrolling and pinching.
        return nil
    }

    func isToolbarPoint(_ point: CGPoint) -> Bool {
        !isHidden && toolbar.frame.contains(point)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard acceptingInput, !isHidden, isUserInteractionEnabled, alpha > 0.01 else { return false }
        let point = touch.location(in: self)
        guard bounds.contains(point), !toolbar.frame.contains(point) else { return false }
        if gestureRecognizer === pencilPath {
            guard touch.type == .pencil, let host = pencilInputHost, pencilPath.view === host,
                  isDescendant(of: host), let touchedView = touch.view,
                  touchedView === host || touchedView.isDescendant(of: host),
                  canReceivePencil?(touch) == true else { return false }
            return transformKind(at: point) == nil
        }
        if gestureRecognizer === transformPan {
            if activeTransform != nil || (transformTouch.map { $0.phase != .ended && $0.phase != .cancelled } ?? false) {
                cancelInteraction()
                return false
            }
            guard let kind = transformKind(at: point) else { return false }
            // A clamped floating button is not the actual corner. Freeze the
            // translation from its touch point to that corner so it behaves
            // exactly like dragging the bottom-right handle, without a jump.
            let offset: CGVector
            if isResizeButtonPoint(point), let rect = selectionRect {
                offset = CGVector(dx: rect.maxX - point.x, dy: rect.maxY - point.y)
            } else { offset = .zero }
            pendingTransform = (kind, CGPoint(x: point.x + offset.dx, y: point.y + offset.dy), offset)
            transformTouch = touch
            return true
        }
        return false
    }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === transformPan { return acceptingInput && pendingTransform != nil }
        if gestureRecognizer === pencilPath { return acceptingInput && activeTransform == nil }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        // An ancestor handles viewport pinching on top of selected content.
        other is UIPinchGestureRecognizer || (other as? UIPanGestureRecognizer).map { $0.minimumNumberOfTouches >= 2 } == true
    }

    @objc private func transformChanged(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            guard acceptingInput, let pendingTransform else { return }
            activeTransform = pendingTransform.kind
            transformPointOffset = pendingTransform.offset
            self.pendingTransform = nil
            if case .resize = pendingTransform.kind { setResizeEmphasized(true) }
            setInteracting(true)
            onBeginTransform?(pendingTransform.kind, pendingTransform.start)
            if activeTransform != nil { onUpdateTransform?(transformedPoint(gesture.location(in: self))) }
        case .changed:
            guard activeTransform != nil else { return }
            if gesture.numberOfTouches > 1 { cancelInteraction() }
            else { onUpdateTransform?(transformedPoint(gesture.location(in: self))) }
        case .ended, .cancelled, .failed:
            pendingTransform = nil
            transformTouch = nil
            guard activeTransform != nil else { return }
            if gesture.state == .ended { onUpdateTransform?(transformedPoint(gesture.location(in: self))) }
            activeTransform = nil
            transformPointOffset = .zero
            onEndTransform?(gesture.state != .ended)
            setInteracting(false)
        default: break
        }
    }

    @objc private func pathChanged(_ gesture: BoardLassoPencilPathGesture) {
        switch gesture.state {
        case .began:
            guard acceptingInput else { return }
            setResizeEmphasized(false)
            activePath = true
            onBeginPath?()
            pathPoints = gesture.points
            setInteracting(true)
        case .changed:
            guard activePath else { return }
            pathPoints = gesture.points
        case .ended:
            guard activePath else { return }
            let points = gesture.points
            activePath = false
            pathPoints = []
            if points.count >= 3 { onSelectPath?(points) }
            setInteracting(false)
        case .cancelled, .failed:
            activePath = false
            pathPoints = []
            setInteracting(false)
        default: break
        }
        setNeedsDisplay()
    }

    private func configure(_ button: UIButton, symbol: String, title: String, id: String) {
        button.setImage(UIImage(systemName: symbol), for: .normal)
        button.accessibilityLabel = title
        button.accessibilityIdentifier = id
        button.tintColor = .label
        toolbar.contentView.addSubview(button)
    }

    private func refreshControls() {
        let hasSelection = selectionRect != nil
        smallerButton.isEnabled = acceptingInput && hasSelection
        largerButton.isEnabled = acceptingInput && hasSelection
        typesButton.isEnabled = acceptingInput
        visibleButton.isEnabled = acceptingInput && !selectedTypes.isEmpty
        moreButton.isEnabled = acceptingInput
        copyButton.isEnabled = acceptingInput
        doneButton.isEnabled = acceptingInput || isWorking
        resizeButton.isEnabled = acceptingInput && hasSelection
        let choices: [(String, String)] = [
            ("ink", String(localized: "手写")), ("document", String(localized: "文档")),
            ("video", String(localized: "视频")), ("image", String(localized: "图片")),
            ("text", String(localized: "文字与公式"))]
        typesButton.accessibilityValue = choices.map(\.0).filter { selectedTypes.contains($0) }.joined(separator: ",")
        let all = UIAction(title: String(localized: "全部类型"), identifier: .init("lasso.type.all")) { [weak self] _ in self?.changeTypes(Self.allTypes) }
        typesButton.menu = UIMenu(title: String(localized: "圈选内容类型"), children: [all] + choices.map { raw, title in
            UIAction(title: title, identifier: .init("lasso.type." + raw), attributes: [.keepsMenuPresented], state: selectedTypes.contains(raw) ? .on : .off) { [weak self] action in
                guard let self else { return }
                var next = self.selectedTypes
                if next.contains(raw) { next.remove(raw) } else { next.insert(raw) }
                action.state = next.contains(raw) ? .on : .off
                self.changeTypes(next)
            }
        })
        let selectionAttributes: UIMenuElement.Attributes = hasSelection ? [] : .disabled
        func copyActions() -> [UIMenuElement] {
            [UIAction(title: String(localized: "复制一份并拖动"), image: UIImage(systemName: "plus.square.on.square"), identifier: .init("lasso.duplicate"), attributes: selectionAttributes) { [weak self] _ in
                self?.performIdle { $0.onDuplicateSelection?() }
            }, UIAction(title: String(localized: "仅复制到剪贴板"), image: UIImage(systemName: "doc.on.clipboard"), identifier: .init("lasso.copyOnly"), attributes: selectionAttributes) { [weak self] _ in
                self?.performIdle { $0.onCopySelection?() }
            }, UIAction(title: String(localized: "粘贴已复制的圈选内容"), image: UIImage(systemName: "clipboard"), identifier: .init("lasso.paste")) { [weak self] _ in
                self?.performIdle { $0.onPasteSelection?() }
            }]
        }
        copyButton.menu = UIMenu(title: String(localized: "复制圈选内容"), children: copyActions())
        moreButton.menu = UIMenu(children: copyActions() + [
            UIAction(title: String(localized: "选择可见内容"), image: UIImage(systemName: "viewfinder"), identifier: .init("lasso.selectVisible"), attributes: selectedTypes.isEmpty ? .disabled : []) { [weak self] _ in self?.performIdle { $0.onSelectVisible?() } },
            UIAction(title: String(localized: "缩小选区"), image: UIImage(systemName: "minus.magnifyingglass"), identifier: .init("lasso.scaleDown"), attributes: selectionAttributes) { [weak self] _ in self?.performIdle { $0.onScale?(0.8) } },
            UIAction(title: String(localized: "放大选区"), image: UIImage(systemName: "plus.magnifyingglass"), identifier: .init("lasso.scaleUp"), attributes: selectionAttributes) { [weak self] _ in self?.performIdle { $0.onScale?(1.25) } },
            UIAction(title: String(localized: "清除选择"), image: UIImage(systemName: "selection.pin.in.out"), identifier: .init("lasso.clear"), attributes: selectionAttributes) { [weak self] _ in self?.performIdle { $0.onClearSelection?() } },
            UIAction(title: String(localized: "原生笔迹套索（复制与剪切）"), image: UIImage(systemName: "lasso"), identifier: .init("lasso.native")) { [weak self] _ in self?.performIdle { $0.onNativeLasso?() } },
            UIAction(title: String(localized: "完成圈选"), image: UIImage(systemName: "checkmark"), identifier: .init("lasso.done")) { [weak self] _ in self?.close() }
        ])
    }

    private func changeTypes(_ next: Set<String>) {
        guard acceptingInput else { return }
        cancelInteraction()
        setResizeEmphasized(false)
        selectedTypes = next.intersection(Self.allTypes)
        refreshControls()
        onTypesChanged?(selectedTypes)
    }

    private func close() {
        if isWorking { cancelInteraction(); onClose?() }
        else { performIdle { $0.onClose?() } }
    }
    private func performIdle(_ action: (BoardLassoOverlay) -> Void) {
        guard acceptingInput else { return }
        cancelInteraction()
        action(self)
    }

    private func setInteracting(_ value: Bool) {
        guard value != isInteracting else { return }
        isInteracting = value
        onInteractionChanged?(value)
    }

    private func corner(at point: CGPoint) -> Corner? {
        Corner.allCases.filter { handles[$0]?.isHidden == false && handles[$0]?.frame.contains(point) == true }
            .min { a, b in
                guard let ac = handles[a]?.center, let bc = handles[b]?.center else { return false }
                return hypot(point.x - ac.x, point.y - ac.y) < hypot(point.x - bc.x, point.y - bc.y)
            }
    }

    private func transformKind(at point: CGPoint) -> TransformKind? {
        if isResizeButtonPoint(point) { return .resize(.bottomRight) }
        if let corner = corner(at: point) { return .resize(corner) }
        if !selectionBody.isHidden, selectionContains(point) { return .move }
        return nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let safe = bounds.inset(by: safeAreaInsets)
        let available = max(0, safe.width - 16)
        let showsVisible = available >= 200
        let showsDone = available >= 152
        // Explicit sizing lives beside the selection; the existing fixed scale
        // actions remain in More for keyboard/VoiceOver and quick steps.
        smallerButton.isHidden = true; largerButton.isHidden = true
        visibleButton.isHidden = !showsVisible; doneButton.isHidden = !showsDone
        copyButton.isHidden = available < 248
        let buttons = [typesButton, visibleButton, smallerButton, largerButton, copyButton, moreButton, doneButton].filter { !$0.isHidden }
        let width = min(available, CGFloat(buttons.count) * 44 + CGFloat(max(0, buttons.count - 1)) * 4 + 12)
        let height: CGFloat = 66
        toolbar.frame = CGRect(x: safe.midX - width / 2,
                               y: min(max(safe.minY + 8 + max(0, toolbarTopInset), safe.minY), max(safe.minY, safe.maxY - height - 8)),
                               width: width, height: min(height, safe.height))
        let buttonWidth = max(0, min(44, (width - 12 - CGFloat(max(0, buttons.count - 1)) * 4) / CGFloat(max(1, buttons.count))))
        for (index, button) in buttons.enumerated() {
            button.frame = CGRect(x: 6 + CGFloat(index) * (buttonWidth + 4), y: 0, width: buttonWidth, height: min(44, toolbar.bounds.height))
        }
        summary.frame = CGRect(x: 6, y: min(43, toolbar.bounds.height), width: max(0, width - 12), height: max(0, toolbar.bounds.height - 43))
        let visibleSelection = Self.validRect(selectionRect?.intersection(bounds))
        selectionBody.isHidden = visibleSelection == nil
        selectionBody.frame = visibleSelection ?? .zero
        for corner in Corner.allCases {
            guard let handle = handles[corner], let rect = selectionRect else { handles[corner]?.isHidden = true; continue }
            let point: CGPoint
            switch corner {
            case .topLeft: point = CGPoint(x: rect.minX, y: rect.minY)
            case .topRight: point = CGPoint(x: rect.maxX, y: rect.minY)
            case .bottomLeft: point = CGPoint(x: rect.minX, y: rect.maxY)
            case .bottomRight: point = CGPoint(x: rect.maxX, y: rect.maxY)
            }
            handle.frame = CGRect(x: point.x - 22, y: point.y - 22, width: 44, height: 44)
            handle.isHidden = !bounds.contains(point)
            if let dot = handle.subviews.first {
                let side: CGFloat = resizeEmphasized ? 24 : 16
                dot.frame = CGRect(x: 22 - side / 2, y: 22 - side / 2, width: side, height: side)
                dot.layer.cornerRadius = side / 2
                dot.layer.borderWidth = resizeEmphasized ? 3 : 2
            }
        }
        layoutResizeButton(in: safe, visibleSelection: visibleSelection)
        bringSubviewToFront(resizeButton)
        bringSubviewToFront(toolbar)
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.clip(to: bounds)
        if let selectionShapePath {
            if let selectionCoveragePath {
                context.addPath(selectionCoveragePath)
                context.setFillColor(UIColor.systemTeal.withAlphaComponent(0.07).cgColor)
                context.fillPath(using: .winding)
            }
            context.addPath(selectionShapePath)
            context.setStrokeColor(UIColor.systemTeal.cgColor)
            context.setLineWidth(resizeEmphasized ? 3 : 2)
            context.setLineDash(phase: 0, lengths: resizeEmphasized ? [] : [6, 4])
            context.strokePath()
        }
        if let first = pathPoints.first {
            context.beginPath(); context.move(to: first)
            for point in pathPoints.dropFirst() { context.addLine(to: point) }
            context.setStrokeColor(UIColor.systemTeal.cgColor)
            context.setLineWidth(2)
            context.setLineDash(phase: 0, lengths: [5, 3])
            context.strokePath()
        }
    }

    private func setSelectionShape(rect: CGRect?, outline: [CGPoint]?) {
        selectionRect = Self.validRect(rect)
        selectionOutline = nil
        selectionShapePath = nil
        selectionCoveragePath = nil
        selectionBoundaryHitPath = nil
        guard let selectionRect else { return }
        let path = CGMutablePath()
        // A pathological off-screen presentation path must not become a large
        // bitmap or capture the whole canvas. Valid normal paths retain every
        // original vertex. Fill uses the same direction-independent bounded
        // lobes as the geometry; repeated loops never cancel into holes.
        if let outline, (3...8192).contains(outline.count),
           outline.allSatisfy({ $0.x.isFinite && $0.y.isFinite && abs($0.x) <= 1_000_000_000 && abs($0.y) <= 1_000_000_000 }) {
            selectionOutline = outline
            path.move(to: outline[0])
            for point in outline.dropFirst() { path.addLine(to: point) }
            path.closeSubpath()
            selectionCoveragePath = coveragePath(for: outline)
        } else {
            path.addRect(selectionRect)
            selectionCoveragePath = path
            coverageReferenceOutline = nil; coverageReferencePath = nil
        }
        selectionShapePath = path
        // The small boundary allowance makes thin circles and narrow shapes
        // draggable without filling their empty bounding-box corners or holes.
        selectionBoundaryHitPath = path.copy(strokingWithWidth: 12, lineCap: .round, lineJoin: .round, miterLimit: 2)
    }

    private func selectionContains(_ point: CGPoint) -> Bool {
        guard selectionShapePath != nil else { return false }
        return selectionCoveragePath?.contains(point, using: .winding) == true
            || selectionBoundaryHitPath?.contains(point, using: .winding) == true
    }

    private func coveragePath(for outline: [CGPoint]) -> CGPath? {
        // Preview/commit transforms preserve vertex order and use only uniform
        // scale + translation. Reuse the vector topology instead of finding
        // self-intersections on every touch-move or viewport update.
        if let reference = coverageReferenceOutline, let path = coverageReferencePath,
           reference.count == outline.count {
            if reference == outline { return path }
            let old = reference.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
            let new = outline.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
            if old.width > 0, old.height > 0 {
                let scale = new.width / old.width
                var transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                    tx: new.minX - old.minX * scale, ty: new.minY - old.minY * scale)
                if scale.isFinite, scale > 0,
                   zip(reference, outline).allSatisfy({ a, b in
                       let mapped = a.applying(transform)
                       return abs(mapped.x - b.x) <= 0.000001 && abs(mapped.y - b.y) <= 0.000001
                   }) {
                    return path.copy(using: &transform)
                }
            }
        }
        guard let path = try? BoardLassoSelection.coveragePath(for: outline) else {
            // Do not turn a failed contour into a filled bounding rectangle.
            coverageReferenceOutline = nil; coverageReferencePath = nil
            return nil
        }
        coverageReferenceOutline = outline; coverageReferencePath = path
        return path
    }

    private static func validRect(_ value: CGRect?) -> CGRect? {
        guard let value, !value.isNull, !value.isInfinite,
              [value.minX, value.minY, value.width, value.height].allSatisfy(\.isFinite), value.width > 0, value.height > 0 else { return nil }
        return value
    }

    private func isResizeButtonPoint(_ point: CGPoint) -> Bool {
        !resizeButton.isHidden && resizeButton.isEnabled && resizeButton.frame.contains(point)
    }

    private func transformedPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x + transformPointOffset.dx, y: point.y + transformPointOffset.dy)
    }

    private func setResizeEmphasized(_ value: Bool) {
        resizeEmphasized = value
        resizeButton.isSelected = value
        resizeButton.accessibilityValue = value
            ? String(localized: "已开启，拖动按钮或四角")
            : String(localized: "轻点或直接拖动")
        refreshSummary()
        setNeedsLayout()
        setNeedsDisplay()
    }

    private func refreshSummary() {
        summary.text = resizeEmphasized ? String(localized: "拖动四角调整大小") : selectionText
    }

    private func layoutResizeButton(in safe: CGRect, visibleSelection: CGRect?) {
        resizeButton.isHidden = true
        guard acceptingInput, visibleSelection != nil, let rect = selectionRect else { return }
        let area = safe.insetBy(dx: 8, dy: 8)
        guard area.width >= 44, area.height >= 48 else { return }
        let size = CGSize(width: min(area.width, max(132, resizeButton.intrinsicContentSize.width)), height: 48)
        let desired = CGPoint(x: rect.maxX - size.width, y: rect.maxY + 30)
        let obstacles = [toolbar.frame.insetBy(dx: -8, dy: -8)]
            + handles.values.filter { !$0.isHidden }.map { $0.frame.insetBy(dx: -6, dy: -6) }
        func placed(_ origin: CGPoint) -> CGRect {
            CGRect(x: min(max(origin.x, area.minX), area.maxX - size.width),
                   y: min(max(origin.y, area.minY), area.maxY - size.height), width: size.width, height: size.height)
        }
        var candidates = [desired,
            CGPoint(x: rect.maxX + 30, y: rect.maxY - size.height),
            CGPoint(x: rect.maxX - size.width, y: rect.minY - size.height - 30),
            CGPoint(x: rect.minX - size.width - 30, y: rect.maxY - size.height)]
        // Explore obstacle edges as well as viewport edges. This remains bounded
        // (at most six obstacles) and finds room in narrow split-screen layouts.
        let xs = [area.minX, area.maxX - size.width, desired.x]
            + obstacles.flatMap { [$0.minX - size.width, $0.maxX] }
        let ys = [area.minY, area.maxY - size.height, desired.y]
            + obstacles.flatMap { [$0.minY - size.height, $0.maxY] }
        for y in ys { for x in xs { candidates.append(CGPoint(x: x, y: y)) } }
        guard let frame = candidates.map(placed).first(where: { candidate in
            !obstacles.contains { $0.intersects(candidate) }
        }) else { return } // A truly too-small viewport must not cover controls.
        resizeButton.frame = frame
        resizeButton.isHidden = false
    }

    private static func title(for corner: Corner) -> String {
        switch corner {
        case .topLeft: String(localized: "选区左上角")
        case .topRight: String(localized: "选区右上角")
        case .bottomLeft: String(localized: "选区左下角")
        case .bottomRight: String(localized: "选区右下角")
        }
    }
}

/// Coalesced Pencil points only. Fingers never become a freehand selection path.
@MainActor private final class BoardLassoPencilPathGesture: UIGestureRecognizer {
    private weak var trackedTouch: UITouch?
    weak var coordinateView: UIView?
    private(set) var points: [CGPoint] = []

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard trackedTouch == nil, touches.count == 1, let touch = touches.first, touch.type == .pencil else {
            state = state == .possible ? .failed : .cancelled; return
        }
        trackedTouch = touch
        points = [touch.location(in: coordinateView ?? view)]
        state = .began
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        append(event.coalescedTouches(for: touch) ?? [touch])
        state = .changed
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = trackedTouch, touches.contains(touch) else { return }
        append([touch]); state = .ended
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .cancelled }
    override func reset() { trackedTouch = nil; points = []; super.reset() }
    private func append(_ touches: [UITouch]) {
        for touch in touches {
            let point = touch.location(in: coordinateView ?? view)
            guard point.x.isFinite, point.y.isFinite else { continue }
            if let last = points.last, hypot(point.x-last.x, point.y-last.y) < 0.75 { continue }
            // Keep a bounded path even if the Pencil is held down for minutes.
            if points.count >= 8_192 { points = points.enumerated().compactMap { $0.offset.isMultiple(of: 2) ? $0.element : nil } }
            points.append(point)
        }
    }
}
