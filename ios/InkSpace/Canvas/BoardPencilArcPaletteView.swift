import UIKit

/// Compact app-owned quick palette for the docked toolbar. The system floating
/// picker keeps its own native Pencil Pro arc when that presentation is chosen.
@MainActor final class BoardPencilArcPaletteView: UIView {
    var onSelect: ((String) -> Void)?
    var onEdit: (() -> Void)?
    var onEditTool: ((String) -> Void)?
    var onManage: (() -> Void)?
    var onClose: (() -> Void)?
    private var buttons: [BoardPaletteToolButton] = []
    private var displayedIDs: [String] = []
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterial))
    private let toolScroll = UIScrollView()
    private let close = UIButton(type: .system)
    private let edit = UIButton(type: .system)
    private let more = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 30; clipsToBounds = true
        layer.borderColor = UIColor.separator.cgColor; layer.borderWidth = 0.5
        addSubview(blur)
        addSubview(toolScroll)
        toolScroll.showsHorizontalScrollIndicator = true
        toolScroll.delaysContentTouches = false
        configure(close, "xmark", String(localized: "关闭"), "nativePalette.arc.close")
        configure(edit, "slider.horizontal.3", String(localized: "颜色与粗细"), "nativePalette.arc.edit")
        configure(more, "ellipsis", String(localized: "添加与编辑工具"), "nativePalette.arc.more")
        close.addAction(UIAction { [weak self] _ in self?.onClose?() }, for: .touchUpInside)
        edit.addAction(UIAction { [weak self] _ in self?.onEdit?() }, for: .touchUpInside)
        more.addAction(UIAction { [weak self] _ in self?.onManage?() }, for: .touchUpInside)
        accessibilityIdentifier = "nativePalette.arc"
        accessibilityLabel = String(localized: "圆弧工具栏")
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
    private func configure(_ button: UIButton, _ symbol: String, _ label: String, _ id: String) {
        button.setImage(UIImage(systemName: symbol), for: .normal); button.accessibilityLabel = label
        button.accessibilityIdentifier = id; addSubview(button)
    }
    func update(_ items: [BoardDockedPaletteView.Item]) {
        // Keep button positions and instances stable between the two taps,
        // including when the first tap changes selection.
        let initial = items.filter { $0.selected } + items.filter { !$0.id.hasPrefix("inkspace.savedPen.") && !$0.selected } + items.filter { $0.id.hasPrefix("inkspace.savedPen.") && !$0.selected }
        if displayedIDs.isEmpty || displayedIDs.contains(where: { id in !items.contains(where: { $0.id == id }) }) {
            displayedIDs = Array(initial.prefix(7).map(\.id))
        }
        let displayed = displayedIDs.compactMap { id in items.first(where: { $0.id == id }) }
        if buttons.map({ $0.accessibilityIdentifier ?? "" }) != displayed.map({ "nativePalette.arc.tool." + $0.id }) {
            buttons.forEach { $0.removeFromSuperview() }; buttons = []
            for item in displayed {
                let button = BoardPaletteToolButton(type: .system)
                configure(button, item.symbol, item.title, "nativePalette.arc.tool." + item.id)
                toolScroll.addSubview(button)
                button.layer.cornerRadius = 22
                button.onSelect = { [weak self] in self?.onSelect?(item.id) }
                button.onEdit = { [weak self] in self?.onEditTool?(item.id) }
                button.accessibilityHint = String(localized: "单击使用，再快速点一下打开快捷设置。")
                buttons.append(button)
            }
        }
        for (item,button) in zip(displayed,buttons) {
            button.setImage(UIImage(systemName: item.symbol), for: .normal)
            button.accessibilityLabel = item.title; button.tintColor = item.color
            button.backgroundColor = item.selected ? .systemTeal.withAlphaComponent(0.2) : .secondarySystemBackground
            if item.selected { button.accessibilityTraits.insert(.selected) } else { button.accessibilityTraits.remove(.selected) }
        }
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews(); blur.frame = bounds
        let compact = bounds.width < 270 || bounds.height < 178
        toolScroll.frame = compact ? CGRect(x: 8, y: 8, width: bounds.width-16, height: 48) : bounds
        toolScroll.isScrollEnabled = compact
        toolScroll.contentSize = compact ? CGSize(width: CGFloat(buttons.count)*48, height: 48) : bounds.size
        let radius = min(105, (bounds.width-48)/2)
        let center = CGPoint(x: bounds.midX, y: bounds.height-47)
        for (index, button) in buttons.enumerated() {
            if compact {
                button.frame = CGRect(x: CGFloat(index)*48, y: 2, width: 44, height: 44)
                continue
            }
            let angle = CGFloat.pi + CGFloat(index) * CGFloat.pi / CGFloat(max(1, buttons.count-1))
            button.frame = CGRect(x: center.x + cos(angle)*radius-22, y: center.y + sin(angle)*radius-22, width: 44, height: 44)
        }
        close.frame = CGRect(x: bounds.midX-22, y: bounds.height-51, width: 44, height: 44)
        edit.frame = CGRect(x: bounds.midX-69, y: bounds.height-51, width: 44, height: 44)
        more.frame = CGRect(x: bounds.midX+25, y: bounds.height-51, width: 44, height: 44)
    }
}
