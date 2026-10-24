import Foundation

/// Matches the two UI localizations in the application bundle. Locale is part
/// of a new reading rendition's identity; existing board references are untouched.
enum DocumentReadingLanguage {
    static var identifier: String {
        Bundle.main.preferredLocalizations.first?.lowercased().hasPrefix("en") == true ? "en" : "zh-Hans"
    }
    static func version(_ renderer: String) -> String { renderer + "-ui-" + identifier }
}
