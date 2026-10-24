import Foundation

/// Local preference for the ordinary website. API settings are independent.
enum AIWebProvider: String, CaseIterable, Identifiable, Sendable {
    case chatgpt, deepseek, claude, gemini
    static let preferenceKey = "inkspace.aiWebProvider"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .chatgpt: "ChatGPT"
        case .deepseek: "DeepSeek"
        case .claude: "Claude"
        case .gemini: "Gemini"
        }
    }
    var startURL: URL {
        switch self {
        case .chatgpt: URL(string: "https://chatgpt.com/")!
        case .deepseek: URL(string: "https://chat.deepseek.com/")!
        case .claude: URL(string: "https://claude.ai/")!
        case .gemini: URL(string: "https://gemini.google.com/app")!
        }
    }
    var origin: String { "https://" + startURL.host! }
    static func selected(in defaults: UserDefaults = .standard) -> Self {
        Self(rawValue: defaults.string(forKey: preferenceKey) ?? "") ?? .chatgpt
    }
    func allowsNavigation(to url: URL, isMainFrame: Bool) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
              let host = url.host?.lowercased() else { return false }
        if !isMainFrame { return true }
        guard url.port == nil || url.port == 443 else { return false }
        let domains: [String]
        switch self {
        case .chatgpt: domains = ["chatgpt.com", "openai.com", "auth0.com"]
        case .deepseek: domains = ["deepseek.com"]
        case .claude: domains = ["claude.ai", "claude.com", "anthropic.com"]
        case .gemini: domains = ["gemini.google.com"]
        }
        let signInHosts = ["accounts.google.com", "appleid.apple.com", "login.microsoftonline.com"]
        return signInHosts.contains(host) || domains.contains { host == $0 || host.hasSuffix("." + $0) }
    }
    /// Clipboard delivery never follows sign-in domains or provider subdomains.
    func permitsPaste(at url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == startURL.host &&
        (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }
    /// Narrow composer contracts, never a generic textarea/search-field fallback.
    /// Sites can change these identifiers; absence means ordinary manual paste.
    func composerSelector(at url: URL) -> String? {
        guard permitsPaste(at: url) else { return nil }
        let path = url.path.lowercased()
        switch self {
        case .chatgpt:
            guard path.isEmpty || path == "/" || path.hasPrefix("/c/") || path.hasPrefix("/g/") else { return nil }
            return "#prompt-textarea[contenteditable='true'], textarea#prompt-textarea"
        case .deepseek:
            guard path.isEmpty || path == "/" || path.hasPrefix("/a/chat/") || path.hasPrefix("/chat/") else { return nil }
            return "textarea#chat-input"
        case .claude:
            guard path.isEmpty || path == "/" || path == "/new" || path.hasPrefix("/chat/") else { return nil }
            return "[data-testid='chat-input'][contenteditable='true'], textarea[data-testid='chat-input']"
        case .gemini:
            guard path == "/app" || path.hasPrefix("/app/") else { return nil }
            return "rich-textarea .ql-editor[contenteditable='true'][role='textbox']"
        }
    }
}
