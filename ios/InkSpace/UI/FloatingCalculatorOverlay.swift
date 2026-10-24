import SwiftUI

/// A modeless calculator: dragging its header never moves the board behind it.
struct FloatingCalculatorOverlay: View {
    @Binding var visible: Bool
    @State private var collapsed = false
    @State private var position = CGSize(width: 20, height: 90)
    @State private var size = CGSize(width: 360, height: 610)
    @GestureState private var drag = CGSize.zero
    @GestureState private var resize = CGSize.zero
    private var zh: Bool { Locale.preferredLanguages.first?.hasPrefix("zh") == true }

    var body: some View {
        GeometryReader { geometry in
            if visible {
                let width = min(max(300, size.width + resize.width), max(300, geometry.size.width - 16))
                let height = collapsed ? 48.0 : min(max(300, size.height + resize.height), max(300, geometry.size.height - 16))
                VStack(spacing: 0) {
                    HStack {
                        Label(zh ? "计算器" : "Calculator", systemImage: "plus.forwardslash.minus")
                            .font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                            .gesture(DragGesture().updating($drag) { value, state, _ in state = value.translation }
                                .onEnded { value in position = clamped(CGSize(width: position.width + value.translation.width, height: position.height + value.translation.height), frame: geometry.size, width: width, height: height) })
                        Button { collapsed.toggle() } label: { Image(systemName: collapsed ? "plus" : "minus") }.accessibilityLabel(zh ? "折叠或展开计算器" : "Collapse or expand calculator").accessibilityIdentifier("calculator.collapse")
                        Button { visible = false } label: { Image(systemName: "xmark") }.accessibilityLabel(zh ? "关闭计算器" : "Close calculator").accessibilityIdentifier("calculator.close")
                    }.padding(12).frame(height: 48)
                    MathWorkbenchView().frame(maxWidth: .infinity, maxHeight: .infinity).opacity(collapsed ? 0 : 1).allowsHitTesting(!collapsed)
                        .overlay(alignment: .bottomTrailing) {
                            if !collapsed {
                                Image(systemName: "arrow.down.right.and.arrow.up.left").padding(10)
                                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8)).contentShape(Rectangle())
                                    .gesture(DragGesture().updating($resize) { value, state, _ in state = value.translation }
                                        .onEnded { value in size = CGSize(width: min(max(300, size.width + value.translation.width), max(300, geometry.size.width - 16)), height: min(max(300, size.height + value.translation.height), max(300, geometry.size.height - 16))) })
                                    .accessibilityLabel(zh ? "调整计算器大小" : "Resize calculator")
                            }
                        }
                }
                .frame(width: width, height: height).clipped()
                .background(.background, in: RoundedRectangle(cornerRadius: 16))
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.secondary.opacity(0.25)))
                .shadow(color: .black.opacity(0.18), radius: 16, y: 5)
                .offset(clamped(CGSize(width: position.width + drag.width, height: position.height + drag.height), frame: geometry.size, width: width, height: height))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("calculator.floating")
            }
        }
    }
    private func clamped(_ value: CGSize, frame: CGSize, width: CGFloat, height: CGFloat) -> CGSize {
        CGSize(width: min(max(8, value.width), max(8, frame.width - width - 8)), height: min(max(8, value.height), max(8, frame.height - height - 8)))
    }
}
