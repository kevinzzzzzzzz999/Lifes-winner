import Foundation
import Security

enum PDFTranslationProvider: String, CaseIterable, Identifiable, Codable, Sendable {
    case openAI, deepSeek, gemini
    var id: String { rawValue }
    var title: String { switch self { case .openAI: "ChatGPT / OpenAI"; case .deepSeek: "DeepSeek"; case .gemini: "Google Gemini" } }
    var defaultModel: String { switch self { case .openAI: "gpt-4.1-mini"; case .deepSeek: "deepseek-flash"; case .gemini: "gemini-2.5-flash-lite" } }
    var endpoint: String { switch self {
    case .openAI: "https://api.openai.com/v1/responses"
    case .deepSeek: "https://api.deepseek.com/chat/completions"
    case .gemini: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    } }
    var modelKey: String { "PDFTranslation.model." + rawValue }
    func model(in defaults: UserDefaults) -> String {
        defaults.string(forKey: modelKey) ?? (self == .openAI ? defaults.string(forKey: "PDFTranslation.model") : nil) ?? defaultModel
    }
    static func selected(in defaults: UserDefaults) -> Self {
        defaults.string(forKey: "PDFTranslation.provider").flatMap(Self.init(rawValue:)) ?? .openAI
    }
}

enum PDFTranslationKeyStore {
    static func read(_ provider: PDFTranslationProvider, namespace: String? = nil) throws -> String {
        if namespace == nil, provider == .openAI { return try APIKeyStore.read() }
        var query = base(provider, namespace: namespace); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &value)
        if result == errSecItemNotFound { return "" }
        guard result == errSecSuccess, let data = value as? Data, let key = String(data: data, encoding: .utf8) else { throw error(result) }
        return key
    }
    static func save(_ key: String, for provider: PDFTranslationProvider, namespace: String? = nil) throws {
        let key = try PDFTranslationInput.key(key, allowEmpty: true)
        if namespace == nil, provider == .openAI { try APIKeyStore.save(key); return }
        let query = base(provider, namespace: namespace), clean = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty {
            let result = SecItemDelete(query as CFDictionary)
            guard result == errSecSuccess || result == errSecItemNotFound else { throw error(result) }
            return
        }
        let values: [String: Any] = [kSecValueData as String: Data(clean.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let result = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if result == errSecItemNotFound {
            let added = SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil)
            guard added == errSecSuccess else { throw error(added) }
        } else if result != errSecSuccess { throw error(result) }
    }
    private static func base(_ provider: PDFTranslationProvider, namespace: String?) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: (namespace ?? "InkSpace.Personal.Translation") + "." + provider.rawValue, kSecAttrAccount as String: "api-key"]
    }
    private static func error(_ status: OSStatus) -> NSError {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: String(localized: "无法访问本机密钥，请解锁设备后重试。")])
    }
}

/// Shared by settings and request construction; never include rejected input in errors.
enum PDFTranslationInput {
    static func key(_ value: String, allowEmpty: Bool = false) throws -> String {
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if result.isEmpty { if allowEmpty { return result }; throw PDFTranslationError.missingKey }
        guard (10...512).contains(result.utf8.count), result.unicodeScalars.allSatisfy({ (33...126).contains($0.value) }) else { throw PDFTranslationError.invalidKey }
        return result
    }
    static func model(_ value: String) throws -> String {
        let result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !result.isEmpty, result.count <= 100, !result.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw PDFTranslationError.invalidSettings }
        return result
    }
}
