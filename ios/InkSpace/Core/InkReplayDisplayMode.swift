import Foundation

enum InkReplayDisplayMode: String, CaseIterable, Sendable {
    case progressive, dimmed
    static let preferenceKey = "InkSpaceReplayDisplayMode"
    static func resolved(_ raw: String?) -> Self { raw.flatMap(Self.init(rawValue:)) ?? .dimmed }
    static var preferred: Self { migratedPreference(in: .standard) }
    static func migratedPreference(in defaults: UserDefaults) -> Self {
        let raw = defaults.string(forKey: preferenceKey)
        let mode = resolved(raw)
        if let raw, raw != mode.rawValue { defaults.set(mode.rawValue, forKey: preferenceKey) }
        return mode
    }
    var title: String { switch self {
    case .progressive: String(localized: "逐步显示")
    case .dimmed: String(localized: "未来笔迹淡化")
    } }
    func opacity(index: Int, visibleCount: Int) -> Double {
        index < visibleCount ? 1 : self == .dimmed ? 0.18 : 0
    }
}
