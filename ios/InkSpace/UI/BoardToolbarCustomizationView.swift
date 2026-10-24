import SwiftUI

/// Small, local presentation settings. The workspace owns the persisted value;
/// no BoardStore observation or canvas state is needed to customize a toolbar.
struct BoardToolbarCustomizationView: View {
    @Binding var hiddenMask: Int
    @Environment(\.dismiss) private var dismiss

    private var visibility: BoardToolbarVisibility { BoardToolbarVisibility(hiddenMask: hiddenMask) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(String(localized: "留出更多书写空间"), systemImage: "slider.horizontal.3")
                            .font(.title3.weight(.semibold)).foregroundStyle(PadDesign.ink)
                        Text(String(localized: "选择工具栏中常用的按钮。隐藏后可随时从省略号菜单重新显示；功能和笔记内容不会被删除。"))
                            .font(.callout).foregroundStyle(PadDesign.secondaryInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    section(String(localized: "书写"), functions: BoardToolbarFunction.writing)
                    section(String(localized: "阅读"), functions: BoardToolbarFunction.reading)
                    section(String(localized: "通用"), functions: BoardToolbarFunction.shared)
                    VStack(alignment: .leading, spacing: 12) {
                        Label(String(localized: "首页、保存、模式切换和选中内容的操作始终保留。"), systemImage: "checkmark.shield")
                            .font(.footnote).foregroundStyle(PadDesign.secondaryInk)
                        Button {
                            hiddenMask = 0
                        } label: {
                            Label(String(localized: "恢复全部显示"), systemImage: "arrow.counterclockwise")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .disabled(hiddenMask == 0)
                        .accessibilityIdentifier("board.toolbar.reset")
                    }
                }
                .padding(20).frame(maxWidth: 640).frame(maxWidth: .infinity)
            }
            .background(PadDesign.paper)
            .navigationTitle(String(localized: "自定义工具栏"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "完成")) { dismiss() }
                        .frame(minHeight: 44).accessibilityIdentifier("board.toolbar.done")
                }
            }
        }
        .tint(PadDesign.accent)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func section(_ title: String, functions: [BoardToolbarFunction]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(PadDesign.secondaryInk)
                .padding(.horizontal, 4)
            VStack(spacing: 0) {
                ForEach(functions) { function in
                    Toggle(isOn: Binding(
                        get: { visibility.isVisible(function) },
                        set: { enabled in
                            var next = visibility
                            next.setVisible(enabled, for: function)
                            hiddenMask = next.hiddenMask
                        })) {
                            Label(function.title, systemImage: function.symbol)
                                .font(.callout).foregroundStyle(PadDesign.ink)
                        }
                        .frame(minHeight: 44).padding(.horizontal, 14).padding(.vertical, 4)
                        .accessibilityIdentifier("board.toolbar.visible." + function.id)
                    if function != functions.last {
                        Divider().overlay(PadDesign.hairline).padding(.leading, 45)
                    }
                }
            }
            .padSurface(radius: 14)
        }
    }
}
