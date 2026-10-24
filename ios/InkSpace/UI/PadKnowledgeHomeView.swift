import SwiftUI

/// Shared appearance only: no navigation, document or persistence state lives here.
enum PadDesign {
    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
    static let paper = adaptive(0xF3F1EA, 0x141B19)
    static let surface = adaptive(0xFBFAF6, 0x1E2924)
    static let sidebar = adaptive(0xEAEDE6, 0x17211C)
    static let ink = adaptive(0x233C35, 0xEDF2EB)
    static let secondaryInk = adaptive(0x596860, 0xB5C2B8)
    static let accent = adaptive(0x244A3B, 0xC1CFB9)
    static let accentWash = adaptive(0xE0E9E0, 0x304A3C)
    static let hairline = adaptive(0xCDD5CC, 0x4B5E52)
    static let bronze = adaptive(0x776035, 0xC9B27E)
    static let hero = adaptive(0x203B32, 0x223C33)
}

private struct PadSurfaceModifier: ViewModifier {
    let radius: CGFloat
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        content
            .background(PadDesign.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(PadDesign.hairline.opacity(contrast == .increased ? 1 : 0.65), lineWidth: contrast == .increased ? 1.5 : 0.7)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
    }
}
extension View {
    func padSurface(radius: CGFloat = 14) -> some View { modifier(PadSurfaceModifier(radius: radius)) }
}

struct PadTileButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.48)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.988 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
    }
}

private struct PadHomeArtwork: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    var body: some View {
        Image("HomeAtelierArt").resizable().scaledToFill()
            .frame(width: 136, height: 152).clipped()
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .opacity(reduceMotion || appeared ? 1 : 0.78)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.42), value: appeared)
            .onAppear { appeared = true }
            .accessibilityHidden(true).allowsHitTesting(false)
    }
}

/// Functional visual vocabulary. These shapes are static decoration and never
/// own a route, animation timer, file, or accessibility element.
enum PadModuleMotif {
    case pages, annotation, board, schedule, scan, coordinates, waveform, nodes, exchange, globe, replay

    static func forEntry(_ id: String) -> Self {
        switch id {
        case "home.highlights", "home.phoneReview", "home.reviews": .annotation
        case "home.newBoard": .board
        case "home.checklist": .schedule
        case "home.scan", "home.ocr": .scan
        case "home.calculator", "home.math": .coordinates
        case "home.media": .waveform
        case "home.assistant": .nodes
        case "home.exchange": .exchange
        case "home.browser": .globe
        case "home.inkReplay": .replay
        default: .pages
        }
    }
}

struct PadModuleArtwork: View {
    let motif: PadModuleMotif
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        Canvas { context, size in
            var art = context
            let scale = min(size.width / 80, size.height / 56)
            art.translateBy(x: (size.width - 80 * scale) / 2, y: (size.height - 56 * scale) / 2)
            art.scaleBy(x: scale, y: scale)
            let width: CGFloat = contrast == .increased ? 2.3 : 1.4
            Self.draw(motif, in: &art, lineWidth: width)
        }
        .accessibilityHidden(true).allowsHitTesting(false)
    }

    private static func draw(_ motif: PadModuleMotif, in c: inout GraphicsContext, lineWidth w: CGFloat) {
        let ink = PadDesign.accent
        let muted = PadDesign.hairline
        let highlight = PadDesign.bronze
        func stroke(_ points: [CGPoint], _ color: Color = PadDesign.accent, close: Bool = false) {
            guard let first = points.first else { return }
            var path = Path(); path.move(to: first)
            for point in points.dropFirst() { path.addLine(to: point) }
            if close { path.closeSubpath() }
            c.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round))
        }
        func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ color: Color = PadDesign.accent) {
            stroke([CGPoint(x: x1, y: y1), CGPoint(x: x2, y: y2)], color)
        }
        func box(_ rect: CGRect, wash: Bool = false, color: Color = PadDesign.accent) {
            let path = Path(roundedRect: rect, cornerRadius: 2)
            if wash { c.fill(path, with: .color(PadDesign.accentWash)) }
            c.stroke(path, with: .color(color), lineWidth: w)
        }
        func dot(_ x: CGFloat, _ y: CGFloat, radius: CGFloat = 3, color: Color = PadDesign.accent) {
            c.fill(Path(ellipseIn: CGRect(x: x-radius, y: y-radius, width: radius*2, height: radius*2)), with: .color(color))
        }
        switch motif {
        case .pages:
            box(CGRect(x: 18, y: 6, width: 37, height: 39), color: muted)
            box(CGRect(x: 25, y: 12, width: 37, height: 39), wash: true)
            line(33, 23, 52, 23); line(33, 30, 52, 30, muted); line(33, 37, 45, 37, highlight)
        case .annotation:
            box(CGRect(x: 14, y: 9, width: 49, height: 38), wash: true)
            c.fill(Path(CGRect(x: 22, y: 25, width: 32, height: 7)), with: .color(highlight.opacity(0.23)))
            line(22, 20, 52, 20, muted); line(22, 29, 52, 29); line(22, 38, 39, 38, muted)
            stroke([CGPoint(x: 56, y: 40), CGPoint(x: 65, y: 31), CGPoint(x: 69, y: 35), CGPoint(x: 60, y: 44)], highlight, close: true)
        case .board:
            box(CGRect(x: 10, y: 11, width: 27, height: 19), wash: true)
            box(CGRect(x: 45, y: 28, width: 24, height: 18), color: highlight)
            line(23, 34, 23, 44, muted); line(23, 44, 41, 44, muted)
            line(43, 10, 43, 20); line(38, 15, 48, 15)
        case .schedule:
            box(CGRect(x: 16, y: 9, width: 49, height: 40), wash: true)
            line(16, 21, 65, 21); line(27, 5, 27, 14); line(54, 5, 54, 14)
            for x in [CGFloat(27), 40, 53] { for y in [CGFloat(29), 39] { dot(x, y, radius: 1.6, color: muted) } }
            stroke([CGPoint(x: 35, y: 36), CGPoint(x: 40, y: 41), CGPoint(x: 49, y: 29)], highlight)
        case .scan:
            let corners: [[CGPoint]] = [
                [.init(x: 12, y: 20), .init(x: 12, y: 8), .init(x: 25, y: 8)],
                [.init(x: 55, y: 8), .init(x: 68, y: 8), .init(x: 68, y: 20)],
                [.init(x: 12, y: 36), .init(x: 12, y: 48), .init(x: 25, y: 48)],
                [.init(x: 55, y: 48), .init(x: 68, y: 48), .init(x: 68, y: 36)]
            ]
            for points in corners { stroke(points) }
            box(CGRect(x: 24, y: 15, width: 32, height: 27), color: muted)
            line(7, 29, 73, 29, highlight); line(31, 22, 49, 22, muted); line(31, 35, 43, 35, muted)
        case .coordinates:
            line(14, 44, 69, 44); line(18, 49, 18, 7)
            for x in [CGFloat(30), 42, 54] { line(x, 42, x, 46, muted) }
            line(16, 19, 20, 19, muted); line(16, 31, 20, 31, muted)
            var curve = Path(); curve.move(to: CGPoint(x: 23, y: 36))
            curve.addCurve(to: CGPoint(x: 66, y: 10), control1: CGPoint(x: 44, y: 46), control2: CGPoint(x: 40, y: 10))
            c.stroke(curve, with: .color(highlight), style: StrokeStyle(lineWidth: w+0.4, lineCap: .round))
            dot(51, 20, radius: 2.8)
        case .waveform:
            line(8, 29, 72, 29, muted)
            for (index, height) in [CGFloat(9), 18, 30, 41, 23, 35, 15, 7].enumerated() {
                let x = CGFloat(12 + index * 8)
                line(x, 29-height/2, x, 29+height/2, index == 3 ? highlight : ink)
            }
        case .nodes:
            stroke([.init(x: 16, y: 30), .init(x: 37, y: 15), .init(x: 63, y: 26), .init(x: 47, y: 44), .init(x: 16, y: 30)], muted)
            line(37, 15, 47, 44, muted)
            dot(16, 30, radius: 5); dot(37, 15, radius: 4, color: highlight)
            dot(63, 26, radius: 5); dot(47, 44, radius: 3.5)
        case .exchange:
            box(CGRect(x: 8, y: 9, width: 24, height: 31), wash: true)
            box(CGRect(x: 48, y: 17, width: 24, height: 31), color: muted)
            stroke([.init(x: 27, y: 19), .init(x: 48, y: 19), .init(x: 44, y: 15)], highlight)
            stroke([.init(x: 52, y: 38), .init(x: 31, y: 38), .init(x: 35, y: 42)])
        case .globe:
            let circle = Path(ellipseIn: CGRect(x: 18, y: 6, width: 44, height: 44))
            c.fill(circle, with: .color(PadDesign.accentWash)); c.stroke(circle, with: .color(ink), lineWidth: w)
            c.stroke(Path(ellipseIn: CGRect(x: 30, y: 6, width: 20, height: 44)), with: .color(muted), lineWidth: w)
            line(18, 28, 62, 28, muted); line(24, 14, 56, 14, muted); line(24, 42, 56, 42, muted)
            dot(55, 15, radius: 3.2, color: highlight)
        case .replay:
            var arc = Path(); arc.addArc(center: CGPoint(x: 38, y: 28), radius: 20, startAngle: .degrees(30), endAngle: .degrees(310), clockwise: false)
            c.stroke(arc, with: .color(muted), style: StrokeStyle(lineWidth: w, lineCap: .round))
            stroke([.init(x: 53, y: 7), .init(x: 52, y: 18), .init(x: 63, y: 17)], highlight)
            let play = Path { p in p.move(to: .init(x: 32, y: 18)); p.addLine(to: .init(x: 48, y: 28)); p.addLine(to: .init(x: 32, y: 38)); p.closeSubpath() }
            c.fill(play, with: .color(ink))
        }
    }
}

/// Shared card label for present and future module menus. All actions remain at
/// the call site; the drawing is separate from accessible title and description.
struct PadModuleTileLabel: View {
    let title: String
    let subtitle: String
    let icon: String
    let motif: PadModuleMotif
    var compact = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var caption: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(PadDesign.ink)
            Text(subtitle).font(.caption).foregroundStyle(PadDesign.secondaryInk).fixedSize(horizontal: false, vertical: true)
        }
    }
    var body: some View {
        Group {
            if compact {
                let layout = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
                layout {
                    PadModuleArtwork(motif: motif).frame(width: 56, height: 42)
                    caption.frame(maxWidth: .infinity, alignment: .leading)
                    if !dynamicTypeSize.isAccessibilitySize {
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                            .foregroundStyle(PadDesign.secondaryInk).accessibilityHidden(true)
                    }
                }
                .padding(16).frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .center) {
                        Image(systemName: icon).font(.system(size: 20, weight: .regular)).foregroundStyle(PadDesign.accent)
                            .frame(width: 32, height: 40, alignment: .leading).accessibilityHidden(true)
                        Spacer(minLength: 8)
                        PadModuleArtwork(motif: motif).frame(width: 76, height: 50)
                    }
                    caption
                }
                .padding(18).frame(maxWidth: .infinity, minHeight: 130, alignment: .topLeading)
            }
        }
        .padSurface(radius: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// BEGIN HOME WORKSPACE ROUTE GATE
enum PadHomeRouteDecision { case waitForCurrentWork, staleVault, ready }
enum PadHomeRouteGate {
    static func decision(expectedRoot: String?, currentRoot: String?, busy: Bool,
                         hasPresentationOrDraft: Bool) -> PadHomeRouteDecision {
        if busy || hasPresentationOrDraft { return .waitForCurrentWork }
        if let expectedRoot, expectedRoot != currentRoot { return .staleVault }
        return .ready
    }
}
// END HOME WORKSPACE ROUTE GATE

struct PadHomeWorkspaceRequest: Identifiable {
    enum Action {
        case chooseVault, browseFolder, boardLibrary, browser, mediaEditor, assistant, calculator, readingContents
        case scanner, phoneReview, reviewList, ocr, inkReplay, noteExchange
        case recent(RecentBrowseEntry)
        case checklist(String)
        case open(ManagedVaultEntry)
        case add([ManagedVaultEntry])
        case newBoard(String)
        case manage(String, [String])

        var allowedOnPhone: Bool {
            switch self {
            case .add, .newBoard, .manage, .mediaEditor, .noteExchange: false
            default: true
            }
        }
    }
    let id = UUID()
    let action: Action
    let expectedRoot: String?

    init(_ action: Action, rootURL: URL? = nil) {
        self.action = action
        expectedRoot = rootURL?.standardizedFileURL.path
    }
}

/// A shared starting point for phone and tablet; the workspace remains the owner
/// of file access, pending editors and all navigation that can change a board.
struct PadKnowledgeHomeView: View {
    @Bindable var store: BoardStore
    let onContinue: () -> Void
    let onRequest: (PadHomeWorkspaceRequest) -> Void
    @AppStorage("padHome.sidebarVisible") private var sidebarVisible = true
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.workspaceWindowActions) private var workspaceWindows
    @State private var compactSidebarVisible = false
    @State private var refreshID = UUID()
    @State private var showsMathWorkspace = false
    @State private var showsSettings = false

    private var canRoute: Bool { !store.isBusy && !store.isSaving }
    private var currentBoardPath: String? { store.boardURL.flatMap { store.relativePath(for: $0) } }
    private var currentDirectory: String { currentBoardPath.map { ($0 as NSString).deletingLastPathComponent } ?? "" }
    private var accent: Color { PadDesign.hero }
    private var controlAccent: Color { PadDesign.accent }
    private var paper: Color { PadDesign.paper }
    private var surface: Color { PadDesign.surface }
    private var hasRecents: Bool { !store.recentBrowse.entries.isEmpty }

    var body: some View {
        GeometryReader { geometry in
            let wide = geometry.size.width >= 850 && !store.usesPhoneInterface
            HStack(spacing: 0) {
                if wide && sidebarVisible {
                    sidebar(onClose: { sidebarVisible = false })
                        .frame(width: min(320, max(280, geometry.size.width * 0.25)))
                    Divider()
                }
                NavigationStack {
                    dashboard(wide: wide, availableWidth: geometry.size.width - ((wide && sidebarVisible) ? min(320, max(280, geometry.size.width * 0.25)) : 0))
                        .navigationTitle(String(localized: "人生赢家"))
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button {
                                    if wide { sidebarVisible.toggle() }
                                    else { compactSidebarVisible = true }
                                } label: { Image(systemName: "sidebar.left").frame(minWidth: 44, minHeight: 44) }
                                .accessibilityLabel(String(localized: "浏览资料"))
                                .accessibilityIdentifier("home.sidebar.toggle")
                            }
                            if workspaceWindows.available {
                                ToolbarItem(placement: .topBarTrailing) {
                                    Button(action: workspaceWindows.newFolder) {
                                        Label(String(localized: "新窗口"), systemImage: "plus.rectangle.on.folder")
                                    }.labelStyle(.titleAndIcon).accessibilityIdentifier("home.newWindow")
                                }
                            }
                            ToolbarItem(placement: .topBarTrailing) {
                                Button { route(PadHomeWorkspaceRequest(.chooseVault)) } label: {
                                    Label(String(localized: "打开文件夹"), systemImage: "folder.badge.plus")
                                }.labelStyle(.titleAndIcon).disabled(!canRoute).accessibilityIdentifier("home.chooseFolder")
                            }
                            if !store.usesPhoneInterface {
                                ToolbarItem(placement: .topBarTrailing) {
                                    Button { route(PadHomeWorkspaceRequest(.boardLibrary)) } label: {
                                        Label(String(localized: "白板资料库"), systemImage: "books.vertical")
                                    }.disabled(!canRoute).accessibilityIdentifier("home.boardLibrary")
                                }
                            }
                        }
                }
            }
            .tint(controlAccent)
        }
        .task {
            store.recentBrowse.reload()
            await store.boardCatalog.load()
            await store.importCatalogRecentHistory()
        }
        .sheet(isPresented: $compactSidebarVisible) {
            sidebar(onClose: { compactSidebarVisible = false })
                .tint(controlAccent)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showsSettings) {
            AppSettingsView()
        }
        .fullScreenCover(isPresented: $showsMathWorkspace) {
            NavigationStack {
                MathWorkbenchView()
                    .navigationTitle(String(localized: "数学工作台"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "完成")) { showsMathWorkspace = false }
                    } }
            }
        }
    }

    private var learningLocation: String {
        guard let root = store.vaultURL else { return String(localized: "先打开你的资料文件夹") }
        return currentDirectory.isEmpty ? root.lastPathComponent : root.lastPathComponent + " / " + currentDirectory
    }

    private func dashboard(wide: Bool, availableWidth: CGFloat) -> some View {
        let contentWidth = availableWidth - (wide ? 56 : 40)
        let columns = !store.usesPhoneInterface && contentWidth >= 850 && !dynamicTypeSize.isAccessibilitySize
        return ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(store.usesPhoneInterface ? String(localized: "阅读空间") : String(localized: "工作台"))
                        .font(.system(.largeTitle, design: .serif).weight(.medium)).tracking(1.2).foregroundStyle(PadDesign.ink)
                    Text(store.usesPhoneInterface ? String(localized: "阅读、标记与扫描，接续同一份学习资料。") : String(localized: "书写与摆放资料，把想法整理到白板。"))
                        .font(.subheadline).foregroundStyle(PadDesign.secondaryInk)
                }
                if columns {
                    HStack(alignment: .top, spacing: 24) {
                        VStack(alignment: .leading, spacing: 26) {
                            continueCard(showsArtwork: contentWidth >= 1050)
                            learningSpace(wide: wide, availableWidth: contentWidth)
                        }.frame(maxWidth: .infinity)
                        VStack(alignment: .leading, spacing: 26) {
                            recentSection
                            toolsSection(twoColumns: false)
                        }.frame(width: 320)
                    }
                } else {
                    continueCard(showsArtwork: !store.usesPhoneInterface && contentWidth >= 580 && !dynamicTypeSize.isAccessibilitySize)
                    recentSection
                    learningSpace(wide: wide, availableWidth: contentWidth)
                    toolsSection(twoColumns: !store.usesPhoneInterface && contentWidth >= 500 && !dynamicTypeSize.isAccessibilitySize)
                }
            }
            .frame(maxWidth: 1240, alignment: .leading)
            .padding(wide ? 28 : 20)
            .frame(maxWidth: .infinity)
        }
        .background(paper)
        .accessibilityIdentifier("home.scroll")
    }

    private func learningSpace(wide: Bool, availableWidth: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading(store.usesPhoneInterface ? String(localized: "随身阅读") : String(localized: "学习空间"), subtitle: learningLocation)
            if store.vaultURL != nil {
                Text(store.usesPhoneInterface
                     ? String(localized: "扫描与批注关联当前资料文件夹，可在其他设备继续查看。")
                     : (store.boardURL == nil ? String(localized: "新白板从仓库根目录开始；课程清单默认保存在资料库主文件夹。") : String(localized: "新白板从当前白板所在文件夹开始；课程清单默认保存在资料库主文件夹。")))
                    .font(.caption).foregroundStyle(PadDesign.secondaryInk)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: dynamicTypeSize.isAccessibilitySize || availableWidth < 480 ? 1 : 2), spacing: 12) {
                actionCard(String(localized: "浏览资料"), subtitle: String(localized: "文件夹、文档与白板"), icon: "folder", id: "home.files") {
                    if store.vaultURL == nil { route(PadHomeWorkspaceRequest(.chooseVault)) }
                    else if wide { sidebarVisible = true }
                    else { compactSidebarVisible = true }
                }
                if store.usesPhoneInterface {
                    actionCard(String(localized: "资料与高亮"), subtitle: String(localized: "打开资料，标记重点"), icon: "highlighter", id: "home.highlights") {
                        if store.vaultURL == nil { route(PadHomeWorkspaceRequest(.chooseVault)) }
                        else if store.boardURL == nil { compactSidebarVisible = true }
                        else { route(PadHomeWorkspaceRequest(.readingContents, rootURL: store.vaultURL)) }
                    }.disabled(!canRoute)
                    actionCard(String(localized: "白板批注"), subtitle: String(localized: "独立评论，可随时删除"), icon: "bubble.and.pencil", id: "home.phoneReview") {
                        route(PadHomeWorkspaceRequest(.phoneReview, rootURL: store.vaultURL))
                    }.disabled(store.boardURL == nil || !canRoute)
                } else {
                    actionCard(String(localized: "新建白板"), subtitle: String(localized: "把想法放在一起"), icon: "square.and.pencil", id: "home.newBoard") {
                        route(PadHomeWorkspaceRequest(.newBoard(currentDirectory), rootURL: store.vaultURL))
                    }.disabled(store.vaultURL == nil || !canRoute)
                    actionCard(String(localized: "课程清单"), subtitle: String(localized: "安排任务，记录进度"), icon: "checklist", id: "home.checklist") {
                        route(PadHomeWorkspaceRequest(.checklist(currentDirectory), rootURL: store.vaultURL))
                    }.disabled(store.vaultURL == nil || !canRoute)
                }
                actionCard(String(localized: "扫描文件"), subtitle: String(localized: "扫描为 PDF，选文件夹保存"), icon: "doc.viewfinder", id: "home.scan") {
                    route(PadHomeWorkspaceRequest(.scanner))
                }.disabled(!canRoute)
            }
        }
    }

    private var recentSection: some View {
        RecentBrowseSection(store: store.recentBrowse, isEnabled: canRoute, limit: store.usesPhoneInterface ? 3 : 4,
            onOpen: openRecent,
            onOpenInNewWindow: workspaceWindows.available ? workspaceWindows.openRecent : nil)
    }

    private func openRecent(_ entry: RecentBrowseEntry) {
        guard canRoute else { return }
        do {
            let root = try store.recentBrowse.resolveRoot(for: entry)
            if root.standardizedFileURL.resolvingSymlinksInPath() != store.vaultURL?.standardizedFileURL.resolvingSymlinksInPath() {
                if workspaceWindows.available { workspaceWindows.openRecent(entry) }
                else { store.status = String(localized: "请先打开这条记录所在的文件夹。") }
            } else {
                route(PadHomeWorkspaceRequest(.recent(entry), rootURL: root))
            }
        } catch { store.status = error.localizedDescription }
    }

    private func toolsSection(twoColumns: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading(String(localized: "学习工具"), subtitle: store.usesPhoneInterface ? String(localized: "轻量记录与计算") : String(localized: "按需要打开，完成后继续白板。"))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: twoColumns ? 2 : 1), spacing: 10) {
                toolRow(String(localized: "待批注"), subtitle: String(localized: "查看当前白板的待处理批注，定位或删除"), icon: "text.bubble", id: "home.reviews") {
                    route(PadHomeWorkspaceRequest(.reviewList, rootURL: store.vaultURL))
                }.disabled(store.boardURL == nil || !canRoute)
                if store.usesPhoneInterface {
                    toolRow(String(localized: "课程清单"), subtitle: String(localized: "安排任务，记录进度"), icon: "checklist", id: "home.checklist") {
                        route(PadHomeWorkspaceRequest(.checklist(currentDirectory), rootURL: store.vaultURL))
                    }.disabled(store.vaultURL == nil || !canRoute)
                } else {
                    toolRow(String(localized: "管理文件"), subtitle: String(localized: "整理当前学习资料"), icon: "folder.badge.gearshape", id: "home.manage") {
                        route(PadHomeWorkspaceRequest(.manage(currentDirectory, []), rootURL: store.vaultURL))
                    }.disabled(store.vaultURL == nil || !canRoute)
                }
                toolRow(String(localized: "笔迹回放"), subtitle: String(localized: "只读回看当前白板的现存笔迹"), icon: "play.rectangle", id: "home.inkReplay") {
                    route(PadHomeWorkspaceRequest(.inkReplay, rootURL: store.vaultURL))
                }.disabled(store.boardURL == nil || !canRoute)
                toolRow(String(localized: "本机文字识别"), subtitle: String(localized: "从 PDF 或图片提取文字"), icon: "text.viewfinder", id: "home.ocr") {
                    route(PadHomeWorkspaceRequest(.ocr, rootURL: store.vaultURL))
                }.disabled(store.vaultURL == nil || !canRoute)
                if !store.usesPhoneInterface {
                    toolRow(String(localized: "笔记交换"), subtitle: String(localized: "导入其他笔记，导出 PDF 与节点纲要"), icon: "arrow.left.arrow.right", id: "home.exchange") {
                        route(PadHomeWorkspaceRequest(.noteExchange, rootURL: store.vaultURL))
                    }.disabled(store.vaultURL == nil || !canRoute)
                }
                toolRow(String(localized: "设置"), subtitle: String(localized: "语言、翻译服务、播放与诊断"), icon: "gearshape", id: "home.settings") {
                    showsSettings = true
                }
                toolRow(String(localized: "AI 助手"), subtitle: String(localized: "围绕当前资料继续思考"), icon: "sparkles", id: "home.assistant") { route(PadHomeWorkspaceRequest(.assistant)) }
                toolRow(String(localized: "科学计算器"), subtitle: String(localized: "随手计算，悬浮在白板旁"), icon: "plus.forwardslash.minus", id: "home.calculator") { route(PadHomeWorkspaceRequest(.calculator)) }
                if !store.usesPhoneInterface {
                    toolRow(String(localized: "数学工作台"), subtitle: String(localized: "计算、公式与图形"), icon: "function", id: "home.math") { showsMathWorkspace = true }
                    toolRow(String(localized: "浏览器"), subtitle: String(localized: "查找资料，摘录到白板"), icon: "globe", id: "home.browser") { route(PadHomeWorkspaceRequest(.browser)) }
                    toolRow(mediaText("视频剪辑", "Video editor"), subtitle: String(localized: "把素材整理成作品"), icon: "film.stack", id: "home.media") { route(PadHomeWorkspaceRequest(.mediaEditor, rootURL: store.vaultURL)) }
                        .disabled(store.vaultURL == nil || !canRoute)
                }
            }
        }
    }

    private func continueCard(showsArtwork: Bool) -> some View {
        HStack(spacing: 20) {
            VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: "pencil.and.outline")
                Text(store.boardURL == nil ? String(localized: "开始学习") : store.usesPhoneInterface ? String(localized: "继续上次的阅读") : String(localized: "继续上次的白板"))
                    .font(.subheadline.weight(.medium))
                Spacer()
                if store.isBusy || store.isSaving { ProgressView().tint(.white) }
            }.foregroundStyle(.white.opacity(0.85))
            Text(store.boardURL == nil ? (store.vaultURL == nil ? String(localized: "让资料与想法相遇") : String(localized: "选择白板，开始学习")) : store.document.title)
                .font(.system(.title2, design: .serif).weight(.semibold)).foregroundStyle(.white).lineLimit(3)
                .accessibilityIdentifier("home.currentTitle")
            Text(store.boardURL == nil
                 ? (store.vaultURL == nil ? String(localized: "打开一个资料文件夹，或从白板资料库找回之前的工作。") : (store.usesPhoneInterface ? String(localized: "从资料文件夹打开白板或 PDF，继续阅读。") : String(localized: "从文件夹打开白板，或在学习空间中新建。")))
                 : (currentBoardPath ?? store.document.title))
                .font(.subheadline).foregroundStyle(.white.opacity(0.82)).lineLimit(2).truncationMode(.middle)
            if store.boardURL != nil {
                Label(store.isDirty ? String(localized: "有更改") : String(localized: "无待保存更改"), systemImage: store.isDirty ? "circle.dotted" : "checkmark.circle")
                    .font(.caption).foregroundStyle(.white.opacity(0.85))
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { continueActions }
                VStack(alignment: .leading, spacing: 12) { continueActions }
            }
            HStack(spacing: 12) {
                Button { route(PadHomeWorkspaceRequest(.chooseVault)) } label: {
                    Label(String(localized: "打开文件夹"), systemImage: "folder")
                        .font(.subheadline.weight(.semibold)).padding(.horizontal, 12).frame(minHeight: 44)
                }.buttonStyle(.plain).foregroundStyle(.white)
                    .background(.white.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                    .disabled(!canRoute).accessibilityIdentifier("home.chooseFolder.primary")
                if workspaceWindows.available {
                    Button(action: workspaceWindows.newFolder) {
                        Label(String(localized: "新窗口"), systemImage: "plus.rectangle.on.folder")
                            .font(.subheadline.weight(.semibold)).padding(.horizontal, 12).frame(minHeight: 44)
                    }.buttonStyle(.plain).foregroundStyle(.white)
                        .background(.white.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                        .disabled(!canRoute).accessibilityIdentifier("home.newWindow.primary")
                }
            }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if showsArtwork { PadHomeArtwork() }
        }
        .padding(store.usesPhoneInterface ? 20 : 24).frame(maxWidth: .infinity, alignment: .leading)
        .background(accent, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(.white.opacity(0.16), lineWidth: 0.8)
                .allowsHitTesting(false).accessibilityHidden(true)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var continueActions: some View {
                Button {
                    if store.vaultURL == nil { route(PadHomeWorkspaceRequest(.chooseVault)) }
                    else if store.boardURL == nil { route(PadHomeWorkspaceRequest(.boardLibrary)) }
                    else { onContinue() }
                } label: {
                    Label(store.vaultURL == nil ? String(localized: "打开文件夹") : store.boardURL == nil ? String(localized: "白板资料库") : store.usesPhoneInterface ? String(localized: "继续阅读") : String(localized: "继续使用白板"), systemImage: "arrow.right")
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: !dynamicTypeSize.isAccessibilitySize, vertical: true)
                        .padding(.horizontal, 15).frame(minHeight: 46)
                        .foregroundStyle(accent).background(.white, in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain).disabled(!canRoute).accessibilityIdentifier("home.continue")
                if store.boardURL != nil && !store.usesPhoneInterface {
                    Button { route(PadHomeWorkspaceRequest(.readingContents, rootURL: store.vaultURL)) } label: {
                        Label(String(localized: "定位白板资料"), systemImage: "doc.text.magnifyingglass")
                            .font(.subheadline.weight(.medium)).foregroundStyle(.white)
                            .padding(.horizontal, 12).frame(minHeight: 46)
                            .background(.white.opacity(0.13), in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain).disabled(!canRoute).accessibilityIdentifier("home.locate")
                }
    }

    private func sectionHeading(_ title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.headline).foregroundStyle(PadDesign.ink)
            Text(subtitle).font(.caption).foregroundStyle(PadDesign.secondaryInk)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
        }
    }

    private func actionCard(_ title: String, subtitle: String, icon: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            PadModuleTileLabel(title: title, subtitle: subtitle, icon: icon, motif: .forEntry(id), compact: store.usesPhoneInterface)
        }.buttonStyle(PadTileButtonStyle()).accessibilityIdentifier(id)
    }

    private func toolRow(_ title: String, subtitle: String, icon: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            PadModuleTileLabel(title: title, subtitle: subtitle, icon: icon, motif: .forEntry(id), compact: true)
        }.buttonStyle(PadTileButtonStyle()).disabled(!canRoute).accessibilityIdentifier(id)
    }

    private func sidebar(onClose: @escaping () -> Void) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(String(localized: "浏览资料")).font(.headline).foregroundStyle(PadDesign.ink)
                Spacer()
                Button(action: onClose) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                    .accessibilityLabel(String(localized: "收起资料侧栏"))
                    .accessibilityIdentifier("home.sidebar.close")
            }.padding(.leading, 16).padding(.trailing, 4)
            Button { route(PadHomeWorkspaceRequest(.chooseVault)) } label: {
                Label(store.vaultURL == nil ? String(localized: "打开文件夹") : String(localized: "更换文件夹"), systemImage: "folder.badge.plus")
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }.buttonStyle(.bordered).padding(.horizontal, 12).padding(.bottom, 8)
                .disabled(!canRoute).accessibilityIdentifier("home.openFolder")
            Divider()
            if let root = store.vaultURL {
                PadVaultSidebar(rootURL: root, currentBoardPath: currentBoardPath,
                    initialDirectory: currentDirectory,
                    refreshToken: refreshID, canOpen: canRoute, canChange: canRoute && !store.usesPhoneInterface, readerOnly: store.usesPhoneInterface,
                    onOpen: { entry in route(PadHomeWorkspaceRequest(.open(entry), rootURL: root)); return true },
                    onAdd: { route(PadHomeWorkspaceRequest(.add($0), rootURL: root)) },
                    onNewBoard: { route(PadHomeWorkspaceRequest(.newBoard($0), rootURL: root)) },
                    onManage: { route(PadHomeWorkspaceRequest(.manage($0, $1), rootURL: root)) },
                    onChooseVault: { route(PadHomeWorkspaceRequest(.chooseVault)) }, onClose: onClose)
                    .id(root.standardizedFileURL.path)
            } else {
                ContentUnavailableView(String(localized: "打开你的学习资料"), systemImage: "folder", description: Text(String(localized: "打开 iCloud 或本机的资料文件夹，在这里逐层浏览。")))
            }
        }
        .background(PadDesign.sidebar)
    }

    private func route(_ request: PadHomeWorkspaceRequest) {
        guard canRoute, !store.usesPhoneInterface || request.action.allowedOnPhone else { return }
        compactSidebarVisible = false
        onRequest(request)
    }
}
