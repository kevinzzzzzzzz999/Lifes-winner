import UIKit
import PencilKit

/// A stable presentation of the existing PencilKit tools. PencilKit's public
/// iOS API cannot disable auto-minimization or set a dock edge. We therefore own
/// this small toolbar, while the native picker continues to own tool behavior.
@MainActor final class BoardDockedPaletteView: UIView, UIPopoverPresentationControllerDelegate {
    struct Item: Equatable {
        var id: String
        var title: String
        var symbol: String
        var color: UIColor
        var selected: Bool
    }
    var onSelect: ((String) -> Void)?
    var onEdit: ((String) -> Void)?
    var onShowArc: (() -> Void)?
    var onManage: (() -> Void)?
    var onSettings: ((BoardPaletteDockSettings) -> Void)?
    private var settings = BoardPaletteDockSettings()
    private var items: [Item] = []
    private let background = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let scroll = UIScrollView()
    private let tools = UIStackView()
    private let position = UIButton(type: .system)
    private let manage = UIButton(type: .system)
    private let minimize = UIButton(type: .system)
    private let expand = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        accessibilityIdentifier = "nativePalette.docked"
        layer.cornerRadius = 18
        layer.borderWidth = 0.5
        layer.borderColor = UIColor.separator.cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = 6
        background.clipsToBounds = true
        background.layer.cornerRadius = 18
        addSubview(background)
        addSubview(scroll)
        scroll.addSubview(tools)
        scroll.delaysContentTouches = false
        scroll.showsVerticalScrollIndicator = true
        scroll.showsHorizontalScrollIndicator = true
        tools.distribution = .fillEqually
        for button in [position, manage, minimize, expand] { addSubview(button) }
        configure(position, symbol: "arrow.up.and.down.and.arrow.left.and.right", title: String(localized: "笔栏位置与样式"), id: "nativePalette.position")
        configure(manage, symbol: "slider.horizontal.3", title: String(localized: "添加与编辑工具"), id: "nativePalette.dockedManage")
        configure(minimize, symbol: "minus", title: String(localized: "最小化笔栏"), id: "nativePalette.minimize")
        configure(expand, symbol: "pencil.tip.crop.circle", title: String(localized: "展开常驻笔栏"), id: "nativePalette.expand")
        manage.addAction(UIAction { [weak self] _ in self?.onManage?() }, for: .touchUpInside)
        minimize.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            var next = self.settings; next.isMinimized = true
            self.onSettings?(next)
        }, for: .touchUpInside)
        expand.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            var next = self.settings; next.isMinimized = false; next.usesSystemPalette = false
            self.onSettings?(next)
        }, for: .touchUpInside)
        position.showsMenuAsPrimaryAction = true
    }

    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    private func configure(_ button: UIButton, symbol: String, title: String, id: String) {
        button.setImage(UIImage(systemName: symbol), for: .normal)
        button.accessibilityLabel = title
        button.accessibilityIdentifier = id
        button.tintColor = .label
    }

    func update(settings: BoardPaletteDockSettings, items: [Item]) {
        let changed = self.items.map(\.id) != items.map(\.id)
        let selectionChanged = self.items.filter(\.selected).map(\.id) != items.filter(\.selected).map(\.id)
        self.settings = settings
        self.items = items
        let compact = settings.isMinimized || settings.usesSystemPalette
        for view in [scroll, position, manage, minimize] { view.isHidden = compact }
        expand.isHidden = !compact
        accessibilityValue = "edge=\(settings.edge.rawValue);minimized=\(settings.isMinimized);system=\(settings.usesSystemPalette)"
        if changed {
            tools.arrangedSubviews.forEach { tools.removeArrangedSubview($0); $0.removeFromSuperview() }
            for item in items {
                let button = BoardPaletteToolButton(type: .system)
                var configuration = UIButton.Configuration.plain()
                configuration.image = UIImage(systemName: item.symbol)
                configuration.title = item.title
                configuration.titleLineBreakMode = .byTruncatingTail
                configuration.imagePlacement = .top
                configuration.imagePadding = 3
                configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
                    var attributes = attributes; attributes.font = .systemFont(ofSize: 10, weight: .medium); return attributes
                }
                configuration.baseForegroundColor = item.color
                configuration.background.backgroundColor = item.selected ? UIColor.systemTeal.withAlphaComponent(0.18) : .clear
                configuration.background.cornerRadius = 10
                configuration.contentInsets = NSDirectionalEdgeInsets(top: 3, leading: 2, bottom: 3, trailing: 2)
                button.configuration = configuration
                button.titleLabel?.lineBreakMode = .byTruncatingTail
                button.titleLabel?.numberOfLines = 1
                button.accessibilityLabel = item.title
                button.accessibilityIdentifier = "nativePalette.tool." + item.id
                if item.selected { button.accessibilityTraits.insert(.selected) }
                button.onSelect = { [weak self] in self?.onSelect?(item.id) }
                button.onEdit = { [weak self] in self?.onEdit?(item.id) }
                button.accessibilityHint = String(localized: "单击使用，再快速点一下打开此工具的快捷设置；支持 Apple Pencil。")
                tools.addArrangedSubview(button)
            }
        }
        // Selection and attribute updates keep the button instances alive so a
        // first tap cannot destroy the double-tap recognizer awaiting tap two.
        for (item, view) in zip(items, tools.arrangedSubviews) {
            guard let button = view as? UIButton else { continue }
            button.configuration?.baseForegroundColor = item.color
            button.configuration?.title = item.title
            button.configuration?.image = UIImage(systemName: item.symbol)
            button.configuration?.background.backgroundColor = item.selected ? UIColor.systemTeal.withAlphaComponent(0.18) : .clear
            button.accessibilityLabel = item.title
            if item.selected { button.accessibilityTraits.insert(.selected) } else { button.accessibilityTraits.remove(.selected) }
        }
        let gestures = BoardPencilGestureSettings.load()
        func actions(squeeze: Bool) -> [UIAction] {
            BoardPencilGestureSettings.Action.allCases.map { action in
                UIAction(title: action.title, state: (squeeze ? gestures.squeeze : gestures.doubleTap) == action ? .on : .off) { [weak self] _ in
                    var next = BoardPencilGestureSettings.load()
                    if squeeze { next.squeeze = action } else { next.doubleTap = action }
                    next.save()
                    if let self { self.update(settings: self.settings, items: self.items) }
                }
            }
        }
        position.menu = UIMenu(children: BoardPaletteDockSettings.Edge.allCases.map { edge in
            UIAction(title: edge.title, state: settings.edge == edge ? .on : .off) { [weak self] _ in
                guard let self else { return }; var next = self.settings; next.edge = edge
                self.onSettings?(next)
            }
        } + [
        UIMenu(title: String(localized: "Pencil 双击"), children: actions(squeeze: false)),
        UIMenu(title: String(localized: "Pencil Pro 捏压"), children: actions(squeeze: true)),
        UIAction(title: String(localized: "显示圆弧工具栏"), image: UIImage(systemName: "pencil.tip.crop.circle")) { [weak self] _ in self?.onShowArc?() },
        UIAction(title: String(localized: "使用原生浮动笔栏"), image: UIImage(systemName: "pencil.tip.crop.circle")) { [weak self] _ in
            guard let self else { return }; var next = self.settings; next.usesSystemPalette = true
            self.onSettings?(next)
        }])
        setNeedsLayout()
        if selectionChanged, let selected = items.firstIndex(where: { $0.selected }), tools.arrangedSubviews.indices.contains(selected) {
            layoutIfNeeded()
            scroll.scrollRectToVisible(tools.arrangedSubviews[selected].frame, animated: false)
        }
    }

    func presentQuickSettings(_ controller: UIViewController, for identifier: String) {
        guard let tool = tools.arrangedSubviews.first(where: { $0.accessibilityIdentifier == "nativePalette.tool." + identifier }) else { return }
        let anchor: UIView
        if scroll.isHidden { anchor = expand }
        else if !scroll.bounds.intersects(tool.convert(tool.bounds, to: scroll)) { anchor = scroll }
        else { anchor = tool }
        var responder: UIResponder? = self
        while responder != nil && !(responder is UIViewController) { responder = responder?.next }
        guard let presenter = responder as? UIViewController, presenter.presentedViewController == nil else { return }
        controller.modalPresentationStyle = .popover
        if let popover = controller.popoverPresentationController {
            popover.sourceView = anchor; popover.sourceRect = anchor.bounds
            popover.permittedArrowDirections = .any; popover.delegate = self
            popover.backgroundColor = controller.view.backgroundColor
        }
        presenter.present(controller, animated: true)
    }
    func adaptivePresentationStyle(for controller: UIPresentationController) -> UIModalPresentationStyle { .none }

    override func layoutSubviews() {
        super.layoutSubviews()
        background.frame = bounds
        expand.frame = bounds
        guard !scroll.isHidden else { return }
        let vertical = settings.edge.isVertical
        tools.axis = vertical ? .vertical : .horizontal
        let length = vertical ? bounds.height : bounds.width
        let thickness = vertical ? bounds.width : bounds.height
        let buttonLength = min(44, max(0, (length - 12) / 4))
        func rect(_ offset: CGFloat, _ size: CGFloat) -> CGRect {
            vertical ? CGRect(x: 4, y: offset, width: thickness - 8, height: size)
                : CGRect(x: offset, y: 4, width: size, height: thickness - 8)
        }
        position.frame = rect(6, buttonLength)
        minimize.frame = rect(length - 6 - buttonLength, buttonLength)
        manage.frame = rect(length - 6 - 2 * buttonLength, buttonLength)
        let scrollLength = max(0, length - 12 - 3 * buttonLength)
        scroll.frame = rect(6 + buttonLength, scrollLength)
        let toolLength = CGFloat(items.count) * 52
        tools.frame = vertical ? CGRect(x: 0, y: 0, width: scroll.bounds.width, height: toolLength)
            : CGRect(x: 0, y: 0, width: toolLength, height: scroll.bounds.height)
        scroll.contentSize = tools.frame.size
    }
}

/// UIControl already receives Pencil and finger taps. Classify completed taps
/// here so first-tap selection is immediate, and a second tap does not toggle a
/// utility twice. There is no platform-default gesture touch-type filter.
@MainActor final class BoardPaletteToolButton: UIButton {
    var onSelect: (() -> Void)?
    var onEdit: (() -> Void)?
    private static weak var lastActivatedButton: BoardPaletteToolButton?
    private var sequence = BoardPaletteTapSequence()
    override init(frame: CGRect) {
        super.init(frame: frame)
        addTarget(self, action: #selector(activate(_:event:)), for: .touchUpInside)
        accessibilityCustomActions = [UIAccessibilityCustomAction(name: String(localized: "快捷设置"), actionHandler: { [weak self] _ in self?.onEdit?(); return true })]
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        sequence.reset()
        super.touchesCancelled(touches, with: event)
    }
    override func accessibilityActivate() -> Bool { sequence.reset(); onSelect?(); return true }
    @objc private func activate(_ sender: UIButton, event: UIEvent?) {
        // UIControl may dispatch after touchesEnded has returned. Read the event
        // supplied to this action, never a temporary field cleared by touch delivery.
        let touch = event?.touches(for: self)?.first ?? event?.allTouches?.first(where: { touch in
            guard let view = touch.view else { return false }
            return view === self || view.isDescendant(of: self)
        })
        guard let touch else { sequence.reset(); Self.lastActivatedButton = nil; onSelect?(); return }
        if Self.lastActivatedButton !== self { sequence.reset() }
        Self.lastActivatedButton = self
        if sequence.accept(time: touch.timestamp, point: touch.location(in: self), input: touch.type.rawValue) { onEdit?() }
        else { onSelect?() }
    }
}

struct BoardPaletteTapSequence {
    private var previous: (time: TimeInterval, point: CGPoint, input: Int)?
    mutating func reset() { previous = nil }
    /// true means second tap / edit; all other accepted taps select immediately.
    mutating func accept(time: TimeInterval, point: CGPoint, input: Int) -> Bool {
        if let prior = previous, time >= prior.time, time - prior.time <= 0.4,
           prior.input == input, hypot(point.x - prior.point.x, point.y - prior.point.y) <= 22 {
            previous = nil; return true
        }
        previous = (time, point, input); return false
    }
}

struct BoardPaletteEraserSettings: Codable, Equatable {
    enum Mode: String, Codable, CaseIterable {
        case stroke, partial, fixed
        var type: PKEraserTool.EraserType { switch self { case .stroke: .vector; case .partial: .bitmap; case .fixed: .fixedWidthBitmap } }
        var title: String { switch self { case .stroke: String(localized: "整笔擦除"); case .partial: String(localized: "局部擦除"); case .fixed: String(localized: "固定宽度") } }
    }
    static let key = "InkSpace.palette.eraserQuick.v1"
    var mode: Mode
    var width: Double
    var tool: PKEraserTool {
        // The width-taking initializer converts bitmap into fixedWidthBitmap.
        guard mode == .fixed else { return PKEraserTool(mode.type) }
        let range = mode.type.validWidthRange
        return PKEraserTool(mode.type, width: min(range.upperBound, max(range.lowerBound, width)))
    }
    static func load(fallback: PKEraserTool, from defaults: UserDefaults = .standard) -> Self {
        if let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode(Self.self, from: data), saved.width.isFinite, saved.width >= 0 { var normalized = saved; normalized.width = Double(saved.tool.width); return normalized }
        var value = Self(mode: fallback.eraserType == .vector ? .stroke : fallback.eraserType == .bitmap ? .partial : .fixed, width: fallback.width)
        value.width = Double(value.tool.width); return value
    }
    func save(to defaults: UserDefaults = .standard) {
        guard width.isFinite, width >= 0 else { return }
        var normalized = self; normalized.width = Double(tool.width)
        guard let data = try? JSONEncoder().encode(normalized) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
