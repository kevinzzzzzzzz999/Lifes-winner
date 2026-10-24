import UIKit
import PencilKit

/// Portals are viewport-sized siblings of the parent PencilKit surface. A child
/// never receives transformed parent ink, and offscreen portals retain only their
/// shared file session rather than a large rendered UIView hierarchy.
@MainActor
final class BoardChildCanvasOverlay: UIView {
    private let store: BoardStore
    private let ancestors: Set<UUID>
    private let depth: Int
    private var panels: [String: BoardChildPanel] = [:]
    private var refreshTimer: Timer?
    private var zoom: CGFloat = 1
    private var offset = CGPoint.zero
    private var stopped = false
    private var updating = false

    init(store: BoardStore, ancestors: Set<UUID>, depth: Int) {
        self.store = store; self.ancestors = ancestors; self.depth = depth
        super.init(frame: .zero)
        backgroundColor = .clear
        clipsToBounds = true
    }
    required init?(coder: NSCoder) { fatalError("Use init(store:ancestors:depth:)") }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        panels.values.contains { !$0.isHidden && $0.frame.contains(point) }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        refreshTimer?.invalidate(); refreshTimer = nil
        guard window != nil, !stopped else { return }
        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.synchronize(zoom: self.zoom, offset: self.offset)
            }
        }
        RunLoop.main.add(timer, forMode: .common); refreshTimer = timer
    }

    func synchronize(zoom: CGFloat, offset: CGPoint) {
        guard !stopped, !updating, bounds.width > 0, bounds.height > 0 else { return }
        updating = true; defer { updating = false }
        self.zoom = zoom; self.offset = offset
        if depth == 0 { store.refreshChildSessionsIfNeeded() }
        var visible = Set<String>()
        for owner in store.document.items {
            for (index, link) in (owner.childBoards ?? []).enumerated() {
                let key = owner.id.uuidString + ":" + link.id.uuidString
                let collapsed = BoardChildLayout.collapsedRect(owner: owner, index: index)
                let world = link.presentation?.expanded == true ? link.presentation!.rect : collapsed
                let screen = CGRect(x: world.minX * zoom - offset.x, y: world.minY * zoom - offset.y,
                                    width: world.width * zoom, height: world.height * zoom)
                guard screen.intersects(bounds), screen.width >= 3, screen.height >= 3 else { continue }
                visible.insert(key)
                let panel: BoardChildPanel
                if let existing = panels[key] { panel = existing }
                else {
                    panel = BoardChildPanel(store: store, ownerID: owner.id, ancestors: ancestors, depth: depth)
                    panels[key] = panel; addSubview(panel)
                }
                panel.update(link: link, fullScreenFrame: screen, parentBounds: bounds, parentZoom: zoom)
            }
        }
        for key in panels.keys.filter({ !visible.contains($0) }) {
            panels.removeValue(forKey: key)?.tearDown()
        }
        isHidden = panels.isEmpty || store.reviewModeEnabled
    }

    func tearDown() {
        guard !stopped else { return }
        stopped = true
        refreshTimer?.invalidate(); refreshTimer = nil
        for panel in panels.values { panel.tearDown() }
        panels.removeAll()
        removeFromSuperview()
    }
}

@MainActor
private final class BoardChildPanel: UIView {
    private let parentStore: BoardStore
    private let ownerID: UUID
    private let ancestors: Set<UUID>
    private let depth: Int
    private var link: BoardChildLink?
    private var child: BoardStore?
    private var host: BoardCanvasHost?
    private var loadTask: Task<Void, Never>?
    private var failedPath: String?
    private var childCanvasSession: UUID?
    private var fullFrame = CGRect.zero
    private var clipFrame = CGRect.zero
    private var parentZoom: CGFloat = 1
    private var fullBodyFrame = CGRect.zero
    private var visibleBodyFrame = CGRect.zero
    private var currentChildCenter = CGPoint.zero
    private var dragOrigin: BoardChildPresentation?
    private var dragOwnerOrigin: CGPoint?
    private var readingViewport: BoardViewport?
    private var mountLease: UUID?
    private let header = UIView()
    private let titleButton = UIButton(type: .system)
    private let expandButton = UIButton(type: .system)
    private let fitButton = UIButton(type: .system)
    private let textButton = UIButton(type: .system)
    private let message = UILabel()

    init(store: BoardStore, ownerID: UUID, ancestors: Set<UUID>, depth: Int) {
        parentStore = store; self.ownerID = ownerID; self.ancestors = ancestors; self.depth = depth
        super.init(frame: .zero)
        backgroundColor = .systemBackground
        clipsToBounds = true
        layer.borderWidth = 1.5; layer.borderColor = UIColor.systemTeal.withAlphaComponent(0.65).cgColor
        layer.cornerRadius = 8
        header.backgroundColor = UIColor.systemTeal.withAlphaComponent(0.13)
        addSubview(header)
        titleButton.contentHorizontalAlignment = .left
        titleButton.titleLabel?.lineBreakMode = .byTruncatingMiddle
        titleButton.addTarget(self, action: #selector(openChild), for: .touchUpInside)
        titleButton.accessibilityIdentifier = "child.open"
        header.addSubview(titleButton)
        expandButton.addTarget(self, action: #selector(toggleExpanded), for: .touchUpInside)
        expandButton.accessibilityIdentifier = "child.expand"
        header.addSubview(expandButton)
        fitButton.setImage(UIImage(systemName: "arrow.up.left.and.arrow.down.right"), for: .normal)
        fitButton.accessibilityLabel = String(localized: "展开全部子白板内容并留出书写空间")
        fitButton.accessibilityIdentifier = "child.fitContents"
        fitButton.addTarget(self, action: #selector(fitContents), for: .touchUpInside)
        header.addSubview(fitButton)
        textButton.setImage(UIImage(systemName: "text.badge.plus"), for: .normal)
        textButton.accessibilityLabel = String(localized: "添加文字或编辑子白板所选文字")
        textButton.accessibilityIdentifier = "child.editText"
        textButton.addTarget(self, action: #selector(editText), for: .touchUpInside)
        header.addSubview(textButton)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(movePanel(_:)))
        pan.maximumNumberOfTouches = 1
        pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue), NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        header.addGestureRecognizer(pan)
        message.numberOfLines = 3; message.textColor = .secondaryLabel
        message.font = .systemFont(ofSize: 12); message.isUserInteractionEnabled = false
        addSubview(message)
    }
    required init?(coder: NSCoder) { fatalError("Use designated initializer") }

    func update(link: BoardChildLink, fullScreenFrame: CGRect, parentBounds: CGRect, parentZoom: CGFloat) {
        if self.link?.path != link.path {
            releaseHost(); child = nil; readingViewport = nil
            loadTask?.cancel(); loadTask = nil; failedPath = nil
        }
        self.link = link; self.parentZoom = parentZoom; fullFrame = fullScreenFrame
        clipFrame = fullScreenFrame.intersection(parentBounds)
        frame = clipFrame
        let expanded = link.presentation?.expanded == true
        let logicalHeaderHeight = BoardChildLayout.headerHeight * parentZoom
        let headerHeight = expanded ? max(28, logicalHeaderHeight) : min(fullScreenFrame.height, max(28, 48 * parentZoom))
        let headerRect = CGRect(x: fullScreenFrame.minX, y: fullScreenFrame.minY,
                                width: fullScreenFrame.width, height: headerHeight)
        header.frame = headerRect.offsetBy(dx: -clipFrame.minX, dy: -clipFrame.minY)
        let fontSize = max(10, min(16, 15 * parentZoom))
        titleButton.titleLabel?.font = .systemFont(ofSize: fontSize, weight: .semibold)
        titleButton.setTitle("▧ " + link.title, for: .normal)
        titleButton.accessibilityLabel = String(localized: "打开子白板") + "：" + link.title
        let editable = !parentStore.isPadReading && !parentStore.usesPhoneInterface && !parentStore.isBusy
        expandButton.isHidden = !editable || headerRect.width < 100
        fitButton.isHidden = !editable || !expanded || headerRect.width < 240
        textButton.isHidden = !editable || !expanded || headerRect.width < 320
        expandButton.setImage(UIImage(systemName: expanded ? "rectangle.compress.vertical" : "rectangle.expand.vertical"), for: .normal)
        expandButton.accessibilityLabel = expanded ? String(localized: "收起子白板") : String(localized: "展开子白板")
        let buttonWidth = min(44, max(28, headerHeight))
        var trailing = headerRect.width
        for button in [expandButton, fitButton, textButton] where !button.isHidden {
            trailing -= buttonWidth
            button.frame = CGRect(x: trailing, y: 0, width: buttonWidth, height: headerHeight)
        }
        titleButton.frame = CGRect(x: 10, y: 0, width: max(0, trailing - 16), height: headerHeight)
        message.frame = CGRect(x: max(8, fullScreenFrame.minX - clipFrame.minX + 12),
                               y: max(0, fullScreenFrame.minY - clipFrame.minY + headerHeight + 8),
                               width: max(0, clipFrame.width - 24), height: max(0, min(70, clipFrame.height - headerHeight - 12)))
        message.font = .systemFont(ofSize: max(8, min(13, 12 * parentZoom)))
        message.isHidden = expanded && child != nil
        if !expanded {
            releaseHost()
            message.text = link.path + "\n" + (parentStore.usesPhoneInterface
                ? String(localized: "轻点标题打开") : String(localized: "轻点标题打开 · 展开后在此编辑"))
            return
        }
        let blocked = ancestors.contains(link.id) || depth >= 4
        if blocked {
            message.isHidden = false
            message.text = ancestors.contains(link.id) ? String(localized: "循环引用已停止展开，仍可打开原白板。") : String(localized: "继续打开此子白板可查看更深层内容。")
            return
        }
        guard fullScreenFrame.width >= 160, fullScreenFrame.height - headerHeight >= 80 else {
            releaseHost(); message.isHidden = false
            message.text = String(localized: "放大后显示子白板内容，或轻点标题打开。")
            return
        }
        if mountLease == nil {
            guard parentStore.childRoot.childCanvasLeases.count < 8 else {
                message.isHidden = false
                message.text = String(localized: "放大或平移到这里显示更多内容，或轻点标题打开。")
                return
            }
            let token = UUID(); mountLease = token; parentStore.childRoot.childCanvasLeases.insert(token)
        }
        if child == nil {
            message.text = failedPath == link.path ? String(localized: "子白板暂未载入，轻点标题检查原文件。") : String(localized: "正在载入子白板…")
            if loadTask == nil, failedPath != link.path {
                loadTask = Task { [weak self] in
                    guard let self else { return }
                    let result = await self.parentStore.childStore(for: link)
                    guard !Task.isCancelled, self.link?.path == link.path else { return }
                    self.child = result; self.failedPath = result == nil ? link.path : nil; self.loadTask = nil
                    if result == nil { self.releaseHost() }
                    self.update(link: self.link ?? link, fullScreenFrame: self.fullFrame,
                                parentBounds: self.superview?.bounds ?? self.clipFrame, parentZoom: self.parentZoom)
                }
            }
            return
        }
        guard let child else { return }
        if childCanvasSession != child.canvasSessionID {
            host?.tearDown(); host?.removeFromSuperview(); host = nil
        }
        childCanvasSession = child.canvasSessionID
        fullBodyFrame = CGRect(x: fullScreenFrame.minX, y: fullScreenFrame.minY + logicalHeaderHeight,
                               width: fullScreenFrame.width, height: max(0, fullScreenFrame.height - logicalHeaderHeight))
        visibleBodyFrame = fullBodyFrame.intersection(parentBounds)
        guard !visibleBodyFrame.isNull, visibleBodyFrame.width > 1, visibleBodyFrame.height > 1 else {
            host?.isHidden = true; return
        }
        if host == nil {
            let canvas = BoardCanvasHost(store: child, embedded: true, ancestors: ancestors, depth: depth + 1)
            host = canvas; insertSubview(canvas, belowSubview: header)
            canvas.embeddedViewportDidChange = { [weak self] center, zoom in self?.childViewportMoved(center: center, zoom: zoom) }
        }
        guard let host else { return }
        host.isHidden = false
        host.frame = visibleBodyFrame.offsetBy(dx: -clipFrame.minX, dy: -clipFrame.minY)
        host.layoutIfNeeded()
        host.synchronize(with: child)
        let viewport = readingViewport ?? link.presentation?.viewport ?? child.document.viewport
        let scale = min(6, max(0.00005, CGFloat(viewport.zoom) * parentZoom))
        var effectiveViewport = viewport; effectiveViewport.zoom = scale / parentZoom
        currentChildCenter = BoardChildLayout.visibleChildCenter(viewport: effectiveViewport, fullBody: fullBodyFrame,
            visibleBody: visibleBodyFrame, parentZoom: parentZoom)
        host.configureEmbeddedViewport(center: currentChildCenter, zoom: scale)
        bringSubviewToFront(header)
    }

    private func childViewportMoved(center: CGPoint, zoom: CGFloat) {
        guard let link, var presentation = link.presentation, zoom > 0 else { return }
        var viewport = BoardChildLayout.viewport(visibleCenter: center, childScreenZoom: zoom, fullBody: fullBodyFrame,
            visibleBody: visibleBodyFrame, parentZoom: parentZoom)
        let limit = BoardChildPresentation.maximumCameraMagnitude
        viewport.x = min(limit, max(-limit, viewport.x)); viewport.y = min(limit, max(-limit, viewport.y))
        if parentStore.isPadReading || parentStore.usesPhoneInterface {
            readingViewport = viewport
            return
        }
        readingViewport = nil
        presentation.viewport = viewport
        parentStore.setChildPresentation(ownerID: ownerID, linkID: link.id, presentation: presentation)
    }

    @objc private func openChild() {
        guard let link else { return }
        Task { await parentStore.openChildBoard(link) }
    }
    @objc private func toggleExpanded() {
        guard let link else { return }
        Task {
            if link.presentation?.expanded == true { await parentStore.collapseChild(ownerID: ownerID, linkID: link.id) }
            else { await parentStore.expandedChild(ownerID: ownerID, linkID: link.id) }
        }
    }
    @objc private func fitContents() {
        guard let link else { return }
        Task { await parentStore.expandedChild(ownerID: ownerID, linkID: link.id, fullContents: true) }
    }
    @objc private func movePanel(_ recognizer: UIPanGestureRecognizer) {
        guard let link, !parentStore.isPadReading, !parentStore.usesPhoneInterface, !parentStore.isBusy else { return }
        switch recognizer.state {
        case .began:
            let owner = parentStore.document.items.first { $0.id == ownerID }
            dragOwnerOrigin = owner.map { CGPoint(x: $0.x, y: $0.y) }
            dragOrigin = link.presentation ?? BoardChildPresentation(expanded: false, x: owner?.x ?? 0,
                y: owner?.y ?? 0, width: 960, height: 724)
            parentStore.externalInteractionActive = true
        case .changed:
            guard var value = dragOrigin else { return }
            let delta = recognizer.translation(in: superview)
            if link.presentation?.expanded != true, let origin = dragOwnerOrigin,
               let index = parentStore.document.items.firstIndex(where: { $0.id == ownerID }) {
                parentStore.moveItemWithChildren(index: index, to: CGPoint(x: origin.x + delta.x / parentZoom,
                                                                         y: origin.y + delta.y / parentZoom))
                parentStore.changed()
                return
            }
            value.x = min(max(0, value.x + delta.x / parentZoom), parentStore.document.canvasWidth - value.width)
            value.y = min(max(0, value.y + delta.y / parentZoom), parentStore.document.canvasHeight - value.height)
            parentStore.setChildPresentation(ownerID: ownerID, linkID: link.id, presentation: value)
        case .ended, .cancelled, .failed:
            parentStore.externalInteractionActive = false; dragOrigin = nil; dragOwnerOrigin = nil
        default: break
        }
    }

    @objc private func editText() {
        guard let child, !parentStore.isPadReading, !parentStore.usesPhoneInterface else { return }
        var responder: UIResponder? = self
        while responder != nil && !(responder is UIViewController) { responder = responder?.next }
        guard let controller = responder as? UIViewController else { return }
        let existing = child.document.items.first { child.selectedIDs.contains($0.id) && ($0.kind == .text || $0.kind == .formula) }
        let alert = UIAlertController(title: existing == nil ? String(localized: "子白板文字") : String(localized: "编辑子白板文字"), message: link?.title, preferredStyle: .alert)
        alert.addTextField { field in field.placeholder = String(localized: "标题"); field.text = existing?.title }
        alert.addTextField { field in field.placeholder = String(localized: "内容"); field.text = existing?.text }
        alert.addAction(UIAlertAction(title: String(localized: "取消"), style: .cancel))
        alert.addAction(UIAlertAction(title: String(localized: "保存"), style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let title = alert?.textFields?.first?.text ?? ""
            let text = alert?.textFields?.last?.text ?? ""
            if let existing, let i = child.document.items.firstIndex(where: { $0.id == existing.id }) {
                child.document.items[i].title = title
                child.document.items[i].updatePlainText(text); child.changed()
            } else {
                child.addItem(BoardItem(kind: .text, x: min(max(0, self.currentChildCenter.x - 180), child.document.canvasWidth - 360),
                    y: min(max(0, self.currentChildCenter.y - 110), child.document.canvasHeight - 220),
                    title: title.isEmpty ? String(localized: "文字") : title, text: text))
            }
        })
        controller.present(alert, animated: true)
    }

    private func releaseHost() {
        host?.tearDown(); host?.removeFromSuperview(); host = nil
        if let token = mountLease { parentStore.childRoot.childCanvasLeases.remove(token); mountLease = nil }
    }
    func tearDown() {
        loadTask?.cancel(); loadTask = nil
        releaseHost()
        removeFromSuperview()
    }
}
