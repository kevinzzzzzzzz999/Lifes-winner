import SwiftUI
import UIKit

/// Observe only the scene containing this anchor. A close starts the same
/// bounded save used on backgrounding; modal/home changes never detach a store.
struct WorkspaceSceneLifetimeAnchor: UIViewRepresentable {
    let store: BoardStore
    func makeCoordinator() -> Coordinator { Coordinator(store: store) }
    func makeUIView(context: Context) -> Anchor {
        let view = Anchor()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        view.attached = { [weak coordinator = context.coordinator] scene in coordinator?.observe(scene) }
        return view
    }
    func updateUIView(_ uiView: Anchor, context: Context) {
        if let scene = uiView.window?.windowScene { context.coordinator.observe(scene) }
    }
    static func dismantleUIView(_ uiView: Anchor, coordinator: Coordinator) {
        uiView.attached = nil
        coordinator.finish()
    }
    final class Anchor: UIView {
        var attached: ((UIWindowScene) -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let scene = window?.windowScene { attached?(scene) }
        }
    }
    @MainActor final class Coordinator {
        let store: BoardStore
        private weak var observedScene: UIWindowScene?
        private var observer: NSObjectProtocol?
        init(store: BoardStore) { self.store = store }
        func observe(_ scene: UIWindowScene) {
            guard scene.activationState != .unattached,
                  observedScene !== scene || observer == nil else { return }
            removeObserver()
            observedScene = scene
            observer = NotificationCenter.default.addObserver(forName: UIScene.didDisconnectNotification,
                object: scene, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.finish() }
            }
        }
        func finish() {
            WorkspaceSceneRegistry.shared.unregister(store: store)
            store.saveForBackground()
            removeObserver()
            observedScene = nil
        }
        private func removeObserver() {
            if let observer { NotificationCenter.default.removeObserver(observer) }
            observer = nil
        }
        deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    }
}
