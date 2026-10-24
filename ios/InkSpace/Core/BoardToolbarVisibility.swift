import Foundation

/// Presentation preferences only. They never change a canvas mode, saved ink,
/// document permissions or a native PencilKit palette. Missing and future
/// functions stay visible; hiding is reversible from the permanent menu.
enum BoardToolbarFunction: Int, CaseIterable, Identifiable {
    case undo, redo, reviews, assistant, locateFiles, lastInk
    case selectText, copyText, translation, viewOptions, penPalette, ruler, boardTools, readAloud

    var id: String { String(rawValue) }
    var bit: Int { 1 << rawValue }

    var title: String {
        switch self {
        case .undo: String(localized: "撤销")
        case .redo: String(localized: "重做")
        case .reviews: String(localized: "待批注")
        case .assistant: String(localized: "AI 网页")
        case .locateFiles: String(localized: "定位资料")
        case .lastInk: String(localized: "最后一笔")
        case .selectText: String(localized: "选择文字")
        case .copyText: String(localized: "复制所选文字")
        case .translation: String(localized: "圈选翻译")
        case .viewOptions: String(localized: "缩放与定位")
        case .penPalette: String(localized: "笔与颜色")
        case .ruler: String(localized: "直尺")
        case .boardTools: String(localized: "白板工具")
        case .readAloud: String(localized: "朗读控制")
        }
    }

    var symbol: String {
        switch self {
        case .undo: "arrow.uturn.backward"
        case .redo: "arrow.uturn.forward"
        case .reviews: "text.bubble"
        case .assistant: "sparkles"
        case .locateFiles: "doc.text.magnifyingglass"
        case .lastInk: "pencil.tip.crop.circle.badge.arrow.forward"
        case .selectText: "text.cursor"
        case .copyText: "doc.on.doc"
        case .translation: "character.bubble"
        case .viewOptions: "viewfinder"
        case .penPalette: "pencil.tip.crop.circle"
        case .ruler: "ruler"
        case .boardTools: "square.grid.2x2"
        case .readAloud: "speaker.wave.2"
        }
    }

    static let writing: [Self] = [.undo, .redo, .penPalette, .ruler, .boardTools]
    static let reading: [Self] = [.selectText, .copyText, .translation, .readAloud]
    static let shared: [Self] = [.reviews, .assistant, .locateFiles, .lastInk, .viewOptions]
}

struct BoardToolbarVisibility: Equatable {
    static let preferenceKey = "InkSpace.boardToolbar.hiddenFunctions.v1"
    static let knownMask = BoardToolbarFunction.allCases.reduce(0) { $0 | $1.bit }
    private(set) var hiddenMask: Int

    init(hiddenMask: Int = 0) {
        // A negative value is malformed rather than an instruction to hide all.
        // Strip unknown bits without changing any other preference namespace.
        self.hiddenMask = hiddenMask >= 0 ? hiddenMask & Self.knownMask : 0
    }

    func isVisible(_ function: BoardToolbarFunction) -> Bool {
        hiddenMask & function.bit == 0
    }

    mutating func setVisible(_ isVisible: Bool, for function: BoardToolbarFunction) {
        if isVisible { hiddenMask &= ~function.bit }
        else { hiddenMask |= function.bit }
    }

    var hiddenCount: Int { BoardToolbarFunction.allCases.filter { !isVisible($0) }.count }
}
