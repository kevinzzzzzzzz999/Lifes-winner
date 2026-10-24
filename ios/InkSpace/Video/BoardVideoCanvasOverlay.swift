import AVFoundation
import UIKit

/// Controls intercept only their own 44-point buttons; the rest remains canvas input.
/// The video layer itself sits below native ink, so playback never covers handwriting.
@MainActor final class BoardVideoCanvasOverlay: UIView {
    let contentView = UIView()
    var onOpen: ((BoardVideoRequest) -> Void)?
    private let playback = BoardVideoPlayback()
    private let playerLayer = AVPlayerLayer()
    private let statusLabel = UILabel()
    private var requests: [UUID: BoardVideoRequest] = [:]
    private var videoRects: [UUID: CGRect] = [:]
    private var controls: [UUID: UIStackView] = [:]
    private var activeID: UUID?
    private var activePath: String?
    private var currentBoardID: UUID?
    private var currentSessionID: UUID?
    private var enabled = false
    private var activeContentRect = CGRect.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentView.isUserInteractionEnabled = false
        contentView.clipsToBounds = true
        playerLayer.videoGravity = .resizeAspect
        contentView.layer.addSublayer(playerLayer)
        statusLabel.numberOfLines = 0; statusLabel.textAlignment = .center
        statusLabel.font = .systemFont(ofSize: 14); statusLabel.textColor = .secondaryLabel
        statusLabel.backgroundColor = .secondarySystemBackground
        contentView.addSubview(statusLabel)
        playback.onChange = { [weak self] in self?.updatePlayback() }
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    func synchronize(store: BoardStore, zoom: CGFloat, offset: CGPoint) {
        if currentBoardID != store.document.id || currentSessionID != store.canvasSessionID {
            stop(); clearControls()
            currentBoardID = store.document.id; currentSessionID = store.canvasSessionID
            enabled = false
        }
        let nextEnabled = store.vaultURL != nil && !store.isBusy && !store.reviewModeEnabled &&
            (store.usesPhoneInterface ? !store.phoneMarkupEnabled && [.ink, .arrange].contains(store.mode) : store.isPadReading || store.mode == .arrange)
        // Writing keeps the cached video preview in the backdrop. Retire live
        // media once on transition, without scanning cards on each pen/pan event.
        guard nextEnabled else {
            if enabled { stop(); clearControls() }
            enabled = false
            if !isHidden { isHidden = true }
            if !contentView.isHidden { contentView.isHidden = true }
            return
        }
        enabled = true
        if isHidden { isHidden = false }
        if contentView.isHidden { contentView.isHidden = false }
        guard let root = store.vaultURL else { return }
        let visible = CGRect(x: offset.x / zoom, y: offset.y / zoom, width: bounds.width / zoom, height: bounds.height / zoom)
        let videos = Array(store.document.items.filter {
            BoardVideo.isVideo($0) && $0.canvasWorldRect.intersects(visible) && $0.width * zoom >= 156 && $0.height * zoom >= 100
        }.prefix(8))
        let visibleIDs = Set(videos.map(\.id))
        for id in Array(controls.keys) where !visibleIDs.contains(id) { controls.removeValue(forKey: id)?.removeFromSuperview(); requests[id] = nil; videoRects[id] = nil }
        if activeID.map({ !visibleIDs.contains($0) }) == true { stop() }
        for item in videos {
            guard let path = item.sourcePath else { continue }
            requests[item.id] = BoardVideoRequest(rootURL: root, relativePath: path, title: item.title)
            let frame = CGRect(x: item.x * zoom - offset.x, y: item.y * zoom - offset.y,
                               width: item.width * zoom, height: item.height * zoom)
            videoRects[item.id] = CGRect(x: frame.minX + 6, y: frame.minY + 34, width: max(1, frame.width - 12), height: max(1, frame.height - 90))
            let control = controls[item.id] ?? makeControls(item.id)
            control.frame = CGRect(x: max(0, frame.minX + 6), y: max(0, min(bounds.maxY - 44, frame.maxY - 50)),
                                   width: min(132, frame.width - 12), height: 44)
            if activeID == item.id {
                if activePath != path { stop() }
                else { activeContentRect = frame.insetBy(dx: 6, dy: 6); activeContentRect.origin.y += 28; activeContentRect.size.height = max(1, activeContentRect.height - 78) }
            }
        }
        updatePlayback()
    }

    private func makeControls(_ id: UUID) -> UIStackView {
        let boardID = currentBoardID, sessionID = currentSessionID
        let play = button("play.fill", title: String(localized: "播放或暂停视频"), id: "video.inline.play.\(id.uuidString)") { [weak self] in
            guard let self, self.enabled, self.currentBoardID == boardID,
                  self.currentSessionID == sessionID, let request = self.requests[id] else { return }
            if self.activeID != id { self.stop(); self.activeID = id; self.activePath = request.relativePath }
            self.activeContentRect = self.videoRects[id] ?? .zero
            self.playback.toggle(request)
            // Geometry is already available even if the user hasn't scrolled again.
            self.setNeedsLayout()
        }
        let open = button("arrow.up.left.and.arrow.down.right", title: String(localized: "在独立播放器打开"), id: "video.open.\(id.uuidString)") { [weak self] in
            guard let self, self.enabled, self.currentBoardID == boardID,
                  self.currentSessionID == sessionID, let request = self.requests[id] else { return }
            self.stop(); self.onOpen?(request)
        }
        let close = button("stop.fill", title: String(localized: "停止播放"), id: "video.inline.stop.\(id.uuidString)") { [weak self] in
            guard let self, self.enabled, self.currentBoardID == boardID,
                  self.currentSessionID == sessionID else { return }
            self.stop()
        }
        let stack = UIStackView(arrangedSubviews: [play, open, close])
        stack.axis = .horizontal; stack.distribution = .fillEqually
        stack.backgroundColor = UIColor.secondarySystemBackground.withAlphaComponent(0.94)
        stack.layer.cornerRadius = 8; stack.clipsToBounds = true
        addSubview(stack); controls[id] = stack
        return stack
    }
    private func button(_ symbol: String, title: String, id: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: symbol), for: .normal)
        button.accessibilityLabel = title; button.accessibilityIdentifier = id
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }
    private func updatePlayback() {
        statusLabel.text = playback.errorMessage ?? (playback.isLoading ? String(localized: "正在加载视频…") : nil)
        statusLabel.isHidden = statusLabel.text == nil
        statusLabel.frame = activeContentRect
        playerLayer.player = playback.player
        playerLayer.isHidden = playback.player == nil
        CATransaction.begin(); CATransaction.setDisableActions(true)
        playerLayer.frame = activeContentRect
        CATransaction.commit()
        for (id, stack) in controls {
            let active = id == activeID
            if let play = stack.arrangedSubviews.first as? UIButton {
                play.setImage(UIImage(systemName: active && playback.isPlaying ? "pause.fill" : active && playback.isLoading ? "xmark" : "play.fill"), for: .normal)
                play.accessibilityValue = active ? (playback.errorMessage ?? (playback.isLoading ? String(localized: "正在加载视频…") : playback.isPlaying ? String(localized: "正在播放") : String(localized: "已暂停"))) : nil
            }
            stack.arrangedSubviews.last?.isHidden = !active
        }
    }
    func stop() { activeID = nil; activePath = nil; playback.stop(); playerLayer.player = nil }
    private func clearControls() {
        controls.values.forEach { $0.removeFromSuperview() }
        controls.removeAll(); requests.removeAll(); videoRects.removeAll()
    }
    func tearDown() {
        playback.onChange = nil; stop(); onOpen = nil
        clearControls()
        contentView.removeFromSuperview()
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, enabled else { return nil }
        for stack in controls.values where !stack.isHidden {
            let local = convert(point, to: stack)
            if let hit = stack.hitTest(local, with: event), hit is UIControl { return hit }
        }
        return nil
    }
}
