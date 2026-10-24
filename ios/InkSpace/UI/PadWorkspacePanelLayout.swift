import Foundation

/// Presentation-only sizing. Hiding a panel never changes the board or its canvas session.
struct PadWorkspacePanelLayout: Equatable {
    let materialWidth: CGFloat
    let toolWidth: CGFloat
    let showsMaterials: Bool
    let docksTool: Bool

    init(width: CGFloat, wantsMaterials: Bool, wantsTool: Bool) {
        let width = max(0, width)
        let minimumCanvas: CGFloat = 560
        materialWidth = min(288, max(248, width * 0.22))
        // Reserve actual canvas space even in iPad split-screen. The tool
        // column never covers the board; hiding it gives that width back.
        toolWidth = min(380, max(300, width * 0.32), width * 0.52)
        docksTool = wantsTool && width > 0
        showsMaterials = wantsMaterials
            && (!wantsTool || docksTool)
            && width >= minimumCanvas + materialWidth + (docksTool ? toolWidth + 2 : 1)
    }
}
