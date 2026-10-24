import SwiftUI
import UIKit

// BEGIN HOME ROUTING MODEL — also exercised by the isolated route checks.
enum KnowledgeHomePhase { case active, inactive, background }
struct KnowledgeHomeLaunchState {
    private(set) var showsHome = true
    private(set) var hasOpenedWorkspace = false

    mutating func continueToWorkspace() {
        hasOpenedWorkspace = true
        showsHome = false
    }
    mutating func showHome() { showsHome = true }
    mutating func receivedExternalNavigation(in _: KnowledgeHomePhase) {
        continueToWorkspace()
    }
    mutating func phaseChanged(to phase: KnowledgeHomePhase, isPad _: Bool) {
        switch phase {
        case .active:
            // Lifecycle changes do not navigate an open workspace. Keeping its
            // view tree and presentations visible preserves PDF reading/audio.
            // Home is still the cold-launch route until explicitly continued.
            if !hasOpenedWorkspace { showsHome = true }
        case .inactive, .background:
            break
        }
    }
}
// END HOME ROUTING MODEL

@main
struct InkSpaceApp: App {
    // Used only for the existing background-only cold launch path, never by a
    // visible scene. All visible workspaces own their own store below.
    @State private var backgroundStore = BoardStore()
    var body: some Scene {
        WindowGroup(id: "workspace", for: WorkspaceWindowRequest.self) { request in
            WorkspaceSceneRoot(request: request)
        }
        .backgroundTask(.appRefresh(BoardBackgroundRefreshController.taskIdentifier)) {
            let stores = WorkspaceSceneRegistry.shared.stores
            if stores.isEmpty {
                await BoardBackgroundRefreshController.shared.performSystemRefresh(store: backgroundStore)
            } else {
                for store in stores {
                    guard !Task.isCancelled else { break }
                    await BoardBackgroundRefreshController.shared.performSystemRefresh(store: store)
                }
            }
        }
    }
}

struct WorkspaceWindowActions {
    var available = false
    var newFolder: () -> Void = {}
    var openRecent: (RecentBrowseEntry) -> Void = { _ in }
}
struct WorkspaceWindowActionsKey: EnvironmentKey {
    static let defaultValue = WorkspaceWindowActions()
}
extension EnvironmentValues {
    var workspaceWindowActions: WorkspaceWindowActions {
        get { self[WorkspaceWindowActionsKey.self] }
        set { self[WorkspaceWindowActionsKey.self] = newValue }
    }
}

private struct WorkspaceSceneRoot: View {
    @Binding var request: WorkspaceWindowRequest?
    @SceneStorage("InkSpace.workspace.sceneID") private var sceneID = UUID().uuidString
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    @State private var configured = false
    @State private var initialFolderRequested = false
    @State private var store = BoardStore()
    @State private var homeRouting = KnowledgeHomeLaunchState()
    @State private var openBoardRequestID = UUID()
    @State private var homeWorkspaceRequest: PadHomeWorkspaceRequest?
    @Environment(\.scenePhase) private var scenePhase

    private func homePhase(_ phase: ScenePhase) -> KnowledgeHomePhase {
        switch phase {
        case .active: .active
        case .inactive: .inactive
        case .background: .background
        @unknown default: .inactive
        }
    }

    var body: some View {
            Group {
                if homeRouting.hasOpenedWorkspace {
                    // Once created, keep this identity alive while the homepage
                    // covers it, including any open text/document editor sheet.
                    InkSpaceWorkspaceView(store: store, openBoardRequestID: openBoardRequestID,
                                          onShowKnowledgeHome: { homeRouting.showHome() },
                                          isCoveredByHome: homeRouting.showsHome,
                                          homeRequest: homeWorkspaceRequest,
                                          onHomeRequestHandled: completeHomeRequest)
                        .allowsHitTesting(!homeRouting.showsHome)
                        .accessibilityHidden(homeRouting.showsHome)
                } else { Color(uiColor: .systemBackground).ignoresSafeArea() }
            }
                .environment(\.workspaceWindowActions, windowActions)
                .tint(PadDesign.accent)
                .background {
                    WorkspaceSceneLifetimeAnchor(store: store).frame(width: 0, height: 0)
                }
                .background {
                    KnowledgeHomeWindowOverlay(store: store, isPresented: homeRouting.showsHome,
                                               isActive: scenePhase == .active, windowActions: windowActions,
                                               onContinue: {
                                                   store.cancelPendingWindowNavigation()
                                                   homeRouting.continueToWorkspace()
                                               },
                                               onRequest: { request in
                                                   if case .recent = request.action { }
                                                   else { store.cancelPendingWindowNavigation() }
                                                   homeWorkspaceRequest = request
                                                   homeRouting.continueToWorkspace()
                                               })
                        .frame(width: 0, height: 0)
                }
                .task(id: scenePhase) {
                    // A system-only cold launch must not enumerate the vault or
                    // decode the saved board just to perform a background check.
                    guard scenePhase == .active else { return }
                    configureScene()
                    if let id = store.workspaceWindowID {
                        WorkspaceSceneRegistry.shared.register(store: store, id: id)
                    }
                    store.backgroundRefresh.enteredForeground(store: store)
                    await store.backgroundRefresh.restoreForForegroundIfNeeded(store: store)
                    await store.boardCatalog.load()
                    guard !Task.isCancelled else { return }
                    await store.backgroundRefresh.retryForegroundRefresh(store: store)
                    if let entry = store.initialWindowNavigationRequest?.recentEntry, !initialFolderRequested {
                        initialFolderRequested = true
                        homeWorkspaceRequest = PadHomeWorkspaceRequest(.recent(entry), rootURL: store.vaultURL)
                        homeRouting.continueToWorkspace()
                    } else if request?.recentEntry != nil, !initialFolderRequested {
                        // An equal-valued WindowGroup binding may still contain
                        // an old payload. Only the independent pending journal
                        // can authorize replay; keep the latest saved location.
                        initialFolderRequested = true
                        if store.boardURL != nil { homeRouting.continueToWorkspace() }
                        else if store.vaultURL != nil {
                            homeWorkspaceRequest = PadHomeWorkspaceRequest(.browseFolder, rootURL: store.vaultURL)
                            homeRouting.continueToWorkspace()
                        }
                    } else if request?.chooseFolder == true, store.vaultURL == nil, !initialFolderRequested {
                        initialFolderRequested = true
                        homeWorkspaceRequest = PadHomeWorkspaceRequest(.chooseVault)
                        homeRouting.continueToWorkspace()
                    } else if request?.folderBookmark != nil, store.boardURL != nil, !initialFolderRequested {
                        initialFolderRequested = true
                        homeRouting.continueToWorkspace()
                    } else if let request, request.chooseFolder == false,
                              let path = request.relativePath, !path.hasSuffix(".inkspace.json"), !initialFolderRequested {
                        initialFolderRequested = true
                        homeWorkspaceRequest = PadHomeWorkspaceRequest(.open(ManagedVaultEntry(path: path, isDirectory: false)), rootURL: store.vaultURL)
                        homeRouting.continueToWorkspace()
                    } else if request?.folderBookmark != nil, store.vaultURL != nil, !initialFolderRequested {
                        initialFolderRequested = true
                        homeWorkspaceRequest = PadHomeWorkspaceRequest(.browseFolder, rootURL: store.vaultURL)
                        homeRouting.continueToWorkspace()
                    }
                }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(60)) }
                        catch { return }
                        guard !Task.isCancelled else { return }
                        _ = await store.save()
                    }
                }
                .task(id: scenePhase) {
                    guard scenePhase == .active else { return }
                    while !Task.isCancelled {
                        await store.reviews.reload()
                        do { try await Task.sleep(for: .seconds(15)) } catch { return }
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    homeRouting.phaseChanged(to: homePhase(phase), isPad: !store.usesPhoneInterface)
                    if phase != .active { store.backgroundRefresh.leftForeground(store: store) }
                    if phase == .background {
                        Task { await store.backgroundRefresh.scheduleNextRefresh() }
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)) { _ in
                    store.backgroundRefresh.protectedDataBecameAvailable(store: store)
                }
                .onChange(of: store.revealWorkspaceRequest) { _, _ in
                    homeRouting.continueToWorkspace()
                }
                .onChange(of: store.pendingWindowRecent) { _, entry in
                    guard let entry else { return }
                    store.pendingWindowRecent = nil
                    homeWorkspaceRequest = PadHomeWorkspaceRequest(.recent(entry), rootURL: store.vaultURL)
                    homeRouting.continueToWorkspace()
                }
                .onOpenURL { url in
                    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
                    if url.scheme?.lowercased() == "inkspace", url.host == "new" {
                        guard !store.usesPhoneInterface else {
                            store.status = String(localized: "请在 iPad 上编辑白板")
                            return
                        }
                        let items = components?.queryItems ?? []
                        let sources = items.filter { $0.name == "source" }
                        let folders = items.filter { $0.name == "folder" }
                        let vaults = items.filter { $0.name == "vault" }
                        let source = sources.first?.value
                        let directory = folders.first?.value
                        let validSource = sources.count == 1 && folders.isEmpty && source.map(VaultPath.isSafeRelative) == true
                        let validFolder = folders.count == 1 && sources.isEmpty && directory.map { $0.isEmpty || VaultPath.isSafeRelative($0) } == true
                        guard validSource || validFolder, vaults.count == 1,
                              let vault = vaults.first?.value, !vault.isEmpty else {
                            store.status = String(localized: "新建白板链接缺少有效的原文件或仓库")
                            return
                        }
                        // URLComponents has already decoded each query value once.
                        // Queue until vault restoration/current file work has finished.
                        homeWorkspaceRequest = nil
                        homeRouting.receivedExternalNavigation(in: homePhase(scenePhase))
                        store.pendingNewBoardSource = source
                        store.pendingNewBoardDirectory = directory
                        store.pendingNewBoardVault = vault
                        store.newBoardRequestID = UUID()
                        return
                    }
                    guard !store.isBusy else {
                        store.status = String(localized: "正在处理当前文档，请稍后再打开链接")
                        return
                    }
                    guard url.scheme?.lowercased() == "inkspace", url.host == "open",
                          let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                            .queryItems?.first(where: { $0.name == "file" })?.value else {
                        store.status = String(localized: "无法识别这个人生赢家链接")
                        return
                    }
                    homeWorkspaceRequest = nil
                    homeRouting.receivedExternalNavigation(in: homePhase(scenePhase))
                    openBoardRequestID = UUID()
                    Task { await store.openBoard(relativePath: path) }
                }
    }

    private var windowActions: WorkspaceWindowActions {
        let action = openWindow
        return WorkspaceWindowActions(available: supportsMultipleWindows && !store.usesPhoneInterface,
            newFolder: { action(id: "workspace", value: WorkspaceWindowRequest()) },
            openRecent: { [weak store] entry in
                guard let store else { return }
                Self.openRecentWindow(entry, store: store, action: action)
            })
    }

    private func completeHomeRequest(_ id: UUID) {
        guard let handled = homeWorkspaceRequest, handled.id == id else { return }
        if var value = request, let entry = value.recentEntry {
            // Best-effort binding cleanup only. The independent journal receipt
            // is written by the store after an ordinary successful open, never
            // merely because this view accepted a route for asynchronous work.
            value.consumeRecentEntry(entry.id)
            request = value
        }
        homeWorkspaceRequest = nil
    }

    private func configureScene() {
        guard !configured else { return }
        configured = true
        let id = request?.windowID ?? sceneID
        sceneID = id
        let legacy = request == nil && WorkspaceSceneRegistry.shared.claimLegacyRestore()
        if request == nil { request = WorkspaceWindowRequest(windowID: id, chooseFolder: false) }
        store.configureWindowPersistence(id: id, allowsLegacyRestore: legacy,
            initialBookmark: request?.folderBookmark,
            initialBoardPath: request?.relativePath.flatMap { $0.hasSuffix(".inkspace.json") ? $0 : nil },
            hasRecentFallback: request?.recentEntry != nil)
        let action = openWindow
        store.focusWorkspaceWindow = { id in
            guard let peer = WorkspaceSceneRegistry.shared.store(forWindow: id),
                  let focus = peer.windowFocusRequest() else { return }
            peer.cancelPendingWindowNavigation()
            peer.revealWorkspaceRequest = UUID()
            action(id: "workspace", value: focus)
        }
    }

    private static func openRecentWindow(_ entry: RecentBrowseEntry, store: BoardStore, action: OpenWindowAction) {
        do {
            let root = try store.recentBrowse.resolveRoot(for: entry)
            let access = root.startAccessingSecurityScopedResource()
            defer { if access { root.stopAccessingSecurityScopedResource() } }
            let bookmark = try root.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
            let existingID = WorkspaceSceneRegistry.shared.window(forRoot: root)
            // A scene may close after the lookup. The complete request can
            // rebuild it and open the exact selected file without an old store.
            let candidate = WorkspaceWindowRequest(windowID: existingID ?? UUID().uuidString,
                folderBookmark: bookmark, relativePath: entry.kind == .folder ? nil : entry.relativePath,
                chooseFolder: false, recentEntry: entry)
            let persistence = WorkspaceWindowPersistence(id: candidate.windowID, allowsLegacyRestore: false)
            let issued = try persistence.issueNavigation(candidate)
            if let existingID, let peer = WorkspaceSceneRegistry.shared.store(forWindow: existingID) {
                peer.prepareWindowNavigation(issued)
                peer.pendingWindowRecent = entry
            }
            action(id: "workspace", value: issued)
        } catch { store.status = String(localized: "无法打开最近浏览，请重新选择原文件夹：\(error.localizedDescription)") }
    }
}

private struct KnowledgeHomeHostedContent: View {
    var store: BoardStore
    var active: Bool
    var windowActions: WorkspaceWindowActions
    var onContinue: () -> Void
    var onRequest: (PadHomeWorkspaceRequest) -> Void

    var body: some View {
        Group {
            PadKnowledgeHomeView(store: store, onContinue: onContinue, onRequest: onRequest)
        }
            // A UIKit-created hosting controller is not a WindowGroup root, so
            // it does not inherit SwiftUI's scene phase automatically.
            .environment(\.scenePhase, active ? .active : .background)
            .environment(\.workspaceWindowActions, windowActions)
    }
}

// BEGIN HOME ACCESSIBILITY COVER — tested with isolated UIKit boundaries.
/// A separate UIWindow is not a sibling accessibility view of the workspace.
/// Hide the exact covered content, not just whichever window happens to be key.
/// Weak entries neither retain dismissed editors nor change their identities.
@MainActor private final class KnowledgeHomeAccessibilityCover {
    private struct Entry {
        weak var view: UIView?
        let wasHidden: Bool
    }
    private var entries: [Entry] = []

    func cover(_ window: UIWindow) {
        hide(window)
        var controller = window.rootViewController
        while let current = controller {
            if let view = current.viewIfLoaded { hide(view) }
            controller = current.presentedViewController
        }
    }

    private func hide(_ view: UIView) {
        if !entries.contains(where: { $0.view === view }) {
            entries.append(Entry(view: view, wasHidden: view.accessibilityElementsHidden))
        }
        // SwiftUI may reconcile an underlying root while Home remains visible.
        // Reassert the cover without replacing the original restoration value.
        view.accessibilityElementsHidden = true
    }

    func restore() {
        let covered = entries
        entries.removeAll()
        for entry in covered { entry.view?.accessibilityElementsHidden = entry.wasHidden }
    }
}
// END HOME ACCESSIBILITY COVER

/// Covers this app scene, including its own presented sheets, without replacing
/// the workspace view tree. No other scene/window/application is inspected.
private struct KnowledgeHomeWindowOverlay: UIViewRepresentable {
    var store: BoardStore
    var isPresented: Bool
    var isActive: Bool
    var windowActions: WorkspaceWindowActions
    var onContinue: () -> Void
    var onRequest: (PadHomeWorkspaceRequest) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(store: store) }
    func makeUIView(context: Context) -> AnchorView {
        let view = AnchorView()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        context.coordinator.anchor = view
        view.didAttach = { [weak coordinator = context.coordinator] in coordinator?.reconcile() }
        return view
    }
    func updateUIView(_ view: AnchorView, context: Context) {
        context.coordinator.windowActions = windowActions
        context.coordinator.onContinue = onContinue
        context.coordinator.onRequest = onRequest
        context.coordinator.requested = isPresented
        context.coordinator.active = isActive
        context.coordinator.reconcile()
    }
    static func dismantleUIView(_ view: AnchorView, coordinator: Coordinator) {
        view.didAttach = nil
        coordinator.dismiss(restoreFocus: false)
    }

    final class AnchorView: UIView {
        var didAttach: (() -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { didAttach?() }
        }
    }

    @MainActor final class Coordinator {
        let store: BoardStore
        init(store: BoardStore) { self.store = store }
        weak var anchor: AnchorView?
        var windowActions = WorkspaceWindowActions()
        var requested = false
        var active = false
        var onContinue: () -> Void = {}
        var onRequest: (PadHomeWorkspaceRequest) -> Void = { _ in }
        private var cover: UIWindow?
        private var host: UIHostingController<KnowledgeHomeHostedContent>?
        private weak var scene: UIWindowScene?
        private weak var previousKeyWindow: UIWindow?
        private weak var previousResponder: UIView?
        private let accessibilityCover = KnowledgeHomeAccessibilityCover()
        private var disconnectObserver: NSObjectProtocol?

        func reconcile() {
            guard requested else { dismiss(restoreFocus: true); return }
            if let host {
                if let window = anchor?.window { accessibilityCover.cover(window) }
                // Keep the same controller and SwiftUI root type: home state
                // survives phase changes while its asynchronous work can pause.
                host.rootView = hostedContent()
                return
            }
            guard active, cover == nil, let scene = anchor?.window?.windowScene else { return }
            self.scene = scene
            let previous = anchor?.window
            previousKeyWindow = previous
            previousResponder = previous.flatMap { firstResponder(in: $0) }
            // Ending keyboard focus commits the current IME composition to the
            // existing field binding; it neither submits nor removes that editor.
            previous?.endEditing(true)
            if let previous { accessibilityCover.cover(previous) }
            let host = UIHostingController(rootView: hostedContent())
            self.host = host
            host.view.backgroundColor = .systemBackground
            host.view.accessibilityViewIsModal = true
            let window = UIWindow(windowScene: scene)
            window.frame = scene.coordinateSpace.bounds
            window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
            window.rootViewController = host
            cover = window
            disconnectObserver = NotificationCenter.default.addObserver(forName: UIScene.didDisconnectNotification, object: scene, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.dismiss(restoreFocus: false) }
            }
            window.makeKeyAndVisible()
            UIAccessibility.post(notification: .screenChanged, argument: host.view)
        }

        private func hostedContent() -> KnowledgeHomeHostedContent {
            KnowledgeHomeHostedContent(store: store, active: active, windowActions: windowActions,
                onContinue: { [weak self] in self?.onContinue() },
                onRequest: { [weak self] request in self?.onRequest(request) })
        }

        func dismiss(restoreFocus: Bool) {
            guard let window = cover else { accessibilityCover.restore(); return }
            if let disconnectObserver { NotificationCenter.default.removeObserver(disconnectObserver) }
            disconnectObserver = nil
            let previous = previousKeyWindow
            let responder = previousResponder
            accessibilityCover.restore()
            window.isHidden = true
            window.rootViewController = nil
            cover = nil
            host = nil
            previousKeyWindow = nil; previousResponder = nil
            let ownedScene = scene
            scene = nil
            guard restoreFocus, let previous, let ownedScene, previous.windowScene === ownedScene,
                  ownedScene.activationState == .foregroundActive || ownedScene.activationState == .foregroundInactive else { return }
            previous.makeKey()
            DispatchQueue.main.async { [weak previous, weak responder] in
                guard let previous, previous.isKeyWindow else { return }
                if let responder, responder.window === previous { _ = responder.becomeFirstResponder() }
                var front = previous.rootViewController
                while let presented = front?.presentedViewController { front = presented }
                UIAccessibility.post(notification: .screenChanged, argument: responder ?? front?.view)
            }
        }
        private func firstResponder(in view: UIView) -> UIView? {
            if view.isFirstResponder { return view }
            for child in view.subviews { if let found = firstResponder(in: child) { return found } }
            return nil
        }
    }
}
