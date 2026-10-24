import SwiftUI

/// Uses the same saved native ink presets as the whiteboard; selecting a preset
/// changes the actual PKCanvasView tool in both PDF writing areas.
struct PDFInkPenMenu: View {
    @Bindable var pane: PDFWorkspacePane
    var onSelect: () -> Void = {}
    var body: some View {
        Menu {
            Button(String(localized: "圆珠笔")) { pane.inkPenSettings.selectedID=nil;onSelect() }
            ForEach(pane.inkPenSettings.pens.filter{SavedPenKind.supportedCases.contains($0.kind)}) { pen in
                Button {
                    pane.inkPenSettings.selectedID=pen.id;onSelect()
                } label: {
                    if pane.inkPenSettings.selectedID==pen.id { Label(pen.name,systemImage:"checkmark") }
                    else { Text(pen.name) }
                }
            }
        } label: {
            Label(pane.selectedInkPen?.name ?? String(localized:"圆珠笔"),systemImage:"pencil.tip")
        }
        .disabled(pane.interactionActive || pane.isSaving || pane.hasPendingWrite)
        .accessibilityIdentifier("pdfWorkspace.savedPen")
    }
}
