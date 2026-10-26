import Foundation
import Network
import Security
import CryptoKit
import CoreFoundation
import Darwin

struct MailAccount: Codable, Sendable { let id: String; let provider: String; let address: String; let createdAt: String }
struct MailRow: Codable, Sendable {
    let accountID: String; let provider: String; let uidValidity: String; let uid: String
    let subject: String; let sender: String; let receivedAt: String?; let messageID: String?; let unread: Bool
}
struct MailPage: Codable, Sendable { let account: MailAccount; let rows: [MailRow]; let nextBeforeSequence: Int?; let total: Int; let uidValidity: String }
struct MailMessage: Codable, Sendable { let row: MailRow; let bodyText: String; let truncated: Bool }

struct WorkMailFailure: Error, LocalizedError, Sendable {
    let code: String
    var message: String {
        switch code {
        case "MAIL_INVALID_REQUEST": "Check the email provider, address and app-specific password or mail authorization code."
        case "MAIL_BUSY": "Another mail operation is in progress. Try again after it finishes."
        case "MAIL_CANCELLED": "The mail operation was cancelled."
        case "MAIL_TIMEOUT": "The mail server did not respond in time. Try again."
        case "MAIL_AUTHENTICATION": "Sign-in failed. Use an eligible account and its app-specific password or mail authorization code."
        case "MAIL_MAILBOX_CHANGED": "This inbox changed its identity. Refresh the inbox before opening this message."
        case "MAIL_NOT_FOUND": "This account or message is no longer available. The Work excerpt is retained."
        case "MAIL_TOO_LARGE": "This response exceeds the safe mail-reading limit."
        case "MAIL_ENCODING": "This message uses an unsupported text encoding."
        case "MAIL_CREDENTIALS": "The account credential is unavailable in the system Keychain. Reconnect the account."
        case "MAIL_STORAGE_PROTECTED": "Mail account metadata cannot be read. The original file has been retained."
        case "MAIL_STORAGE_CHANGED": "Mail account metadata changed. Reload before trying again."
        case "MAIL_STORAGE": "The mail account change could not be saved. Check local storage."
        case "MAIL_PROTOCOL": "The server returned a mail response that cannot be read safely."
        default: "The secure mail connection could not be completed."
        }
    }
    var errorDescription: String? { message }
    static func fail(_ code: String) -> Self { Self(code: code) }
}

private enum MailRules {
    static let hosts = ["gmail": "imap.gmail.com", "icloud": "imap.mail.me.com", "qq": "imap.qq.com"]
    static let headerBytes = 65_536, bodyBytes = 262_144, responseBytes = 4 * 1_024 * 1_024
    static func stamp() -> String { ISO8601DateFormatter().string(from: Date()) }
    static func timestamp(_ value: String) -> Bool {
        value.range(of: #"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$"#, options: .regularExpression) != nil
            && (ISO8601DateFormatter().date(from: value) != nil || { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: value) != nil }())
    }
    static func uuid(_ text: String) -> Bool { UUID(uuidString: text) != nil }
    static func number(_ text: String) -> Bool { !text.isEmpty && text.count <= 10 && text.allSatisfy(\.isASCII) && text.utf8.allSatisfy { $0 >= 48 && $0 <= 57 } && (UInt32(text) ?? 0) > 0 }
    static func address(_ text: String) -> Bool {
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        return text.utf8.count <= 254 && parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty
            && text.utf8.allSatisfy { $0 > 32 && $0 < 127 && $0 != 34 && $0 != 92 }
    }
    static func quoted(_ text: String) -> String { "\"" + text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
    static func hash(_ data: Data?) -> String { data.map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() } ?? "missing" }
}

protocol WorkMailCredentials: Sendable {
    func read(_ id: String) throws -> String
    func set(_ password: String, id: String) throws
    func remove(_ id: String) throws
}
private struct MailKeychain: WorkMailCredentials {
    private let service = "lifeswinner.work.mail.v1"
    private func query(_ id: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id] }
    func read(_ id: String) throws -> String {
        var q = query(id); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let bytes = result as? Data,
              let value = String(data: bytes, encoding: .utf8), !value.isEmpty else { throw WorkMailFailure.fail("MAIL_CREDENTIALS") }
        return value
    }
    func set(_ password: String, id: String) throws {
        let q = query(id), bytes = Data(password.utf8)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var added = q; added[kSecValueData as String] = bytes
            added[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(added as CFDictionary, nil) == errSecSuccess else { throw WorkMailFailure.fail("MAIL_CREDENTIALS") }
        } else if status != errSecSuccess { throw WorkMailFailure.fail("MAIL_CREDENTIALS") }
    }
    func remove(_ id: String) throws {
        let status = SecItemDelete(query(id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw WorkMailFailure.fail("MAIL_CREDENTIALS") }
    }
}

private struct MailIndex: Codable { let version: Int; var accounts: [MailAccount] }
private final class MailMetadata: @unchecked Sendable {
    let directory: URL
    init(directory: URL?) {
        if let directory { self.directory = directory }
        else {
            let p = realpath(NSHomeDirectory(), nil)
            let home = p.map { String(cString: $0) } ?? NSHomeDirectory()
            if let p { free(p) }
            self.directory = URL(fileURLWithPath: home, isDirectory: true).appendingPathComponent("Library/Application Support/InkSpace/WorkMail", isDirectory: true)
        }
    }
    func locked<T>(_ body: (Int32) throws -> T) throws -> T {
        guard directory.isFileURL, directory.path.hasPrefix("/") else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }
        var p = directory
        while p.path != "/" { var s = stat(); if lstat(p.path, &s) == 0 && s.st_mode & S_IFMT == S_IFLNK { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }; p.deleteLastPathComponent() }
        do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        catch { throw WorkMailFailure.fail("MAIL_STORAGE") }
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }; defer { close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw WorkMailFailure.fail("MAIL_STORAGE_CHANGED") }; defer { _ = flock(fd, LOCK_UN) }
        return try body(fd)
    }
    func read(_ fd: Int32) throws -> (MailIndex, Data?) {
        let file = openat(fd, "accounts-v1.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if file < 0 && errno == ENOENT { return (MailIndex(version: 1, accounts: []), nil) }
        guard file >= 0 else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }; defer { close(file) }
        var before = stat(); guard fstat(file, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
              before.st_size > 0, before.st_size <= 131_072, before.st_flags & 0x40000000 == 0 else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true { let n = buffer.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }; guard n >= 0 else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }; if n == 0 { break }; guard data.count <= 131_072 - n else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }; data.append(contentsOf: buffer.prefix(n)) }
        var after = stat(); guard fstat(file, &after) == 0, data.count == before.st_size, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw WorkMailFailure.fail("MAIL_STORAGE_CHANGED") }
        do {
            guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(raw.keys) == ["version", "accounts"], let rows = raw["accounts"] as? [[String: Any]], rows.allSatisfy({ Set($0.keys) == ["id", "provider", "address", "createdAt"] }) else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }
            let index = try JSONDecoder().decode(MailIndex.self, from: data)
            guard index.version == 1, index.accounts.count <= 8, Set(index.accounts.map { $0.id.lowercased() }).count == index.accounts.count,
                  Set(index.accounts.map { $0.provider + "#" + $0.address.lowercased() }).count == index.accounts.count,
                  index.accounts.allSatisfy({ MailRules.uuid($0.id) && MailRules.hosts[$0.provider] != nil && MailRules.address($0.address) && MailRules.timestamp($0.createdAt) }) else { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }
            return (index, data)
        } catch let e as WorkMailFailure { throw e } catch { throw WorkMailFailure.fail("MAIL_STORAGE_PROTECTED") }
    }
    enum PublishFailure: Error { case beforePublish, afterPublish }
    func write(_ index: MailIndex, expected: Data?, fd: Int32) throws {
        let data = try JSONEncoder().encode(index)
        guard data.count <= 131_072 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
        guard try read(fd).1 == expected else { throw WorkMailFailure.fail("MAIL_STORAGE_CHANGED") }
        let name = ".pending-" + UUID().uuidString
        let output = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard output >= 0 else { throw PublishFailure.beforePublish }; var published = false
        defer { close(output); if !published { _ = unlinkat(fd, name, 0) } }
        do {
            try data.withUnsafeBytes { raw in var at = 0; while at < data.count { let n = Darwin.write(output, raw.baseAddress!.advanced(by: at), data.count - at); guard n > 0 else { throw PublishFailure.beforePublish }; at += n } }
            guard fsync(output) == 0 else { throw PublishFailure.beforePublish }; try Task.checkCancellation()
            guard try read(fd).1 == expected, renameat(fd, name, fd, "accounts-v1.json") == 0 else { throw PublishFailure.beforePublish }; published = true
            if fsync(fd) != 0 { guard try read(fd).1 == data else { throw PublishFailure.afterPublish } }
        } catch { if published { throw PublishFailure.afterPublish }; throw error }
    }
}

protocol WorkMailTransport: Sendable {
    func open(timeout: TimeInterval) async throws
    func send(_ bytes: Data, timeout: TimeInterval) async throws
    func receive(timeout: TimeInterval) async throws -> Data
    func close()
}
private final class MailOnce<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    init(_ value: CheckedContinuation<T, Error>) { continuation = value }
    @discardableResult func finish(_ result: Result<T, Error>) -> Bool {
        lock.lock(); let current = continuation; continuation = nil; lock.unlock()
        current?.resume(with: result)
        return current != nil
    }
}
/// Host is supplied only by MailRules.hosts. No verification override exists.
private final class MailTLS: WorkMailTransport, @unchecked Sendable {
    let connection: NWConnection
    let queue = DispatchQueue(label: "lifeswinner.work.mail.tls", qos: .utility)
    init(host: String) {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, host)
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        connection = NWConnection(host: NWEndpoint.Host(host), port: 993, using: parameters)
    }
    func close() { connection.cancel() }
    private func perform<T: Sendable>(timeout: TimeInterval, _ start: @escaping @Sendable (MailOnce<T>) -> Void) async throws -> T {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let once = MailOnce<T>(continuation)
                queue.asyncAfter(deadline: .now() + max(0.01, timeout)) { [weak self] in
                    if once.finish(.failure(WorkMailFailure.fail("MAIL_TIMEOUT"))) { self?.close() }
                }
                start(once)
            }
        }, onCancel: { self.close() })
    }
    func open(timeout: TimeInterval) async throws {
        let _: Bool = try await perform(timeout: timeout) { [self] once in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: once.finish(.success(true))
                case .failed: once.finish(.failure(WorkMailFailure.fail("MAIL_CONNECTION")))
                case .cancelled: once.finish(.failure(WorkMailFailure.fail("MAIL_CANCELLED")))
                default: break
                }
            }
            connection.start(queue: queue)
        }
    }
    func send(_ bytes: Data, timeout: TimeInterval) async throws {
        let _: Bool = try await perform(timeout: timeout) { [self] once in
            connection.send(content: bytes, completion: .contentProcessed { error in
                once.finish(error == nil ? .success(true) : .failure(WorkMailFailure.fail("MAIL_CONNECTION")))
            })
        }
    }
    func receive(timeout: TimeInterval) async throws -> Data {
        try await perform(timeout: timeout) { [self] once in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { bytes, _, ended, error in
                if let bytes, !bytes.isEmpty { once.finish(.success(bytes)) }
                else { once.finish(.failure(WorkMailFailure.fail(error != nil || ended ? "MAIL_CONNECTION" : "MAIL_PROTOCOL"))) }
            }
        }
    }
}

private indirect enum MailToken: Sendable {
    case atom(String), list([MailToken]), literal(Data)
    var atom: String? { if case .atom(let v) = self { return v }; return nil }
    var list: [MailToken]? { if case .list(let v) = self { return v }; return nil }
    var literal: Data? { if case .literal(let v) = self { return v }; return nil }
}
private struct MailLexer {
    let bytes: [UInt8]; let literals: [Data]
    var at = 0, count = 0
    mutating func tokens(depth: Int = 0) throws -> [MailToken] {
        guard depth <= 12 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
        var result: [MailToken] = []
        while at < bytes.count {
            let c = bytes[at]
            if c == 32 || c == 9 { at += 1; continue }
            if c == 41 { guard depth > 0 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; at += 1; return result }
            count += 1; guard count <= 8192 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
            if c == 40 { at += 1; result.append(.list(try tokens(depth: depth + 1))); continue }
            if c == 1 {
                at += 1; let start = at
                while at < bytes.count && bytes[at] != 2 { at += 1 }
                guard at < bytes.count, let n = Int(String(decoding: bytes[start..<at], as: UTF8.self)), literals.indices.contains(n) else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                at += 1; result.append(.literal(literals[n])); continue
            }
            if c == 34 {
                at += 1; var quoted: [UInt8] = [], closed = false
                while at < bytes.count {
                    let value = bytes[at]; at += 1
                    if value == 34 { closed = true; break }
                    if value == 92 { guard at < bytes.count else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; quoted.append(bytes[at]); at += 1 }
                    else { quoted.append(value) }
                }
                guard closed, let value = String(bytes: quoted, encoding: .utf8) else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                result.append(.atom(value)); continue
            }
            let start = at; var bracket = false
            while at < bytes.count {
                let value = bytes[at]
                if !bracket && (value == 32 || value == 9 || value == 40 || value == 41) { break }
                if value == 91 { guard !bracket else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; bracket = true }
                if value == 93 { guard bracket else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; bracket = false }
                guard value > 31 && value != 127 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                at += 1
            }
            guard at > start, !bracket else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
            result.append(.atom(String(decoding: bytes[start..<at], as: UTF8.self)))
        }
        guard depth == 0 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; return result
    }
}
private struct MailFetch: Sendable {
    let sequence: Int
    let fields: [String: MailToken]
    var uid: String? { fields["UID"]?.atom }
    var unread: Bool { !(fields["FLAGS"]?.list ?? []).contains { $0.atom?.caseInsensitiveCompare("\\Seen") == .orderedSame } }
    var header: Data? { fields.first { $0.key.hasPrefix("BODY[HEADER.FIELDS ") }?.value.literal }
}
private struct MailResponse: Sendable { let lines: [String]; let fetches: [MailFetch] }

private actor MailSession {
    nonisolated let transport: any WorkMailTransport
    let deadline = ProcessInfo.processInfo.systemUptime + 45
    private var buffer = Data(), tagNumber = 0, receives = 0
    init(_ transport: any WorkMailTransport) { self.transport = transport }
    func remaining() throws -> TimeInterval { try Task.checkCancellation(); let left = deadline - ProcessInfo.processInfo.systemUptime; guard left > 0 else { throw WorkMailFailure.fail("MAIL_TIMEOUT") }; return min(15, left) }
    private func nextChunk() async throws -> Data {
        receives += 1; guard receives <= 8192 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
        return try await transport.receive(timeout: remaining())
    }
    private func line() async throws -> String {
        while true {
            try Task.checkCancellation()
            if let end = buffer.range(of: Data([13, 10])) {
                guard end.lowerBound <= 16_384 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
                let data = Data(buffer[..<end.lowerBound]); buffer = Data(buffer[end.upperBound...])
                guard data.allSatisfy({ $0 == 9 || ($0 >= 32 && $0 != 127) }), let text = String(data: data, encoding: .utf8) else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                return text
            }
            guard buffer.count <= 16_384 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
            let next = try await nextChunk(); guard !next.isEmpty else { throw WorkMailFailure.fail("MAIL_CONNECTION") }; buffer.append(next)
        }
    }
    private func literal(_ size: Int) async throws -> Data {
        while buffer.count < size { let next = try await nextChunk(); guard !next.isEmpty else { throw WorkMailFailure.fail("MAIL_CONNECTION") }; buffer.append(next); guard buffer.count <= MailRules.responseBytes else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") } }
        let result = Data(buffer.prefix(size)); buffer = Data(buffer.dropFirst(size)); return result
    }
    func start(address: String, password: String) async throws {
        try await transport.open(timeout: remaining())
        let greeting = try await line()
        let status = greeting.split(separator: " ", maxSplits: 2)
        guard status.count >= 2, status[0] == "*", status[1].uppercased() == "OK" else { throw WorkMailFailure.fail("MAIL_CONNECTION") }
        _ = try await command("LOGIN " + MailRules.quoted(address) + " " + MailRules.quoted(password), authentication: true)
    }
    /// Tagged completions are parsed only outside declared literals. A forged
    /// tag inside a header/body is data and can never finish a command.
    func command(_ command: String, authentication: Bool = false) async throws -> MailResponse {
        guard command.utf8.count <= 4096, !command.contains("\r"), !command.contains("\n") else { throw WorkMailFailure.fail("MAIL_INVALID_REQUEST") }
        tagNumber += 1; let tag = "LW\(tagNumber)"
        try await transport.send(Data((tag + " " + command + "\r\n").utf8), timeout: remaining())
        var lines: [String] = [], fetches: [MailFetch] = [], metadata = "", literals: [Data] = [], balance = 0, total = 0, events = 0
        while true {
            let raw = try await line(); total += raw.utf8.count; events += 1
            guard total <= MailRules.responseBytes, events <= 4096 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
            if raw.hasPrefix(tag + " ") {
                guard metadata.isEmpty else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                let status = raw.dropFirst(tag.count + 1).split(separator: " ").first?.uppercased()
                if status != "OK" { throw WorkMailFailure.fail(authentication ? "MAIL_AUTHENTICATION" : "MAIL_PROTOCOL") }
                return MailResponse(lines: lines, fetches: fetches)
            }
            if raw.uppercased().hasPrefix("* BYE") { throw WorkMailFailure.fail("MAIL_CONNECTION") }
            var text = raw
            let beginsFetch = text.range(of: #"^\* [1-9][0-9]* FETCH \("#, options: [.regularExpression, .caseInsensitive]) != nil
            if beginsFetch { guard metadata.isEmpty else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; balance = 0; literals = [] }
            if !beginsFetch && metadata.isEmpty {
                guard text.hasPrefix("* "), text.range(of: #"\{[0-9]+\+?\}$"#, options: .regularExpression) == nil else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                lines.append(text); continue
            }
            var size: Int?
            if let marker = text.range(of: #"\{[0-9]+\}$"#, options: .regularExpression) {
                guard let value = Int(text[marker].dropFirst().dropLast()), value >= 0, value <= MailRules.bodyBytes else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
                size = value; text.removeSubrange(marker)
            }
            var quoted = false, escaped = false, bracket = false
            for byte in text.utf8 {
                if escaped { escaped = false; continue }
                if quoted && byte == 92 { escaped = true; continue }
                if byte == 34 { quoted.toggle(); continue }
                if quoted { continue }
                if byte == 91 { bracket = true }; if byte == 93 { bracket = false }
                if !bracket { if byte == 40 { balance += 1 }; if byte == 41 { balance -= 1; guard balance >= 0 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") } } }
            }
            guard !quoted, !bracket else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
            metadata += " " + text
            if let size { total += size; guard total <= MailRules.responseBytes else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }; let bytes = try await literal(size); metadata += " \u{1}\(literals.count)\u{2}"; literals.append(bytes) }
            if balance == 0 {
                var lexer = MailLexer(bytes: Array(metadata.utf8), literals: literals)
                let tokens = try lexer.tokens()
                guard tokens.count == 4, tokens[0].atom == "*", let sequenceText = tokens[1].atom, let sequence = Int(sequenceText), sequence > 0,
                      tokens[2].atom?.uppercased() == "FETCH", let pairs = tokens[3].list, pairs.count % 2 == 0 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                var fields: [String: MailToken] = [:]
                for n in stride(from: 0, to: pairs.count, by: 2) { guard let key = pairs[n].atom?.uppercased(), fields[key] == nil else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; fields[key] = pairs[n + 1] }
                guard let uid = fields["UID"]?.atom, MailRules.number(uid) else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                fetches.append(MailFetch(sequence: sequence, fields: fields)); guard fetches.count <= 100 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
                metadata = ""; literals = []
            }
        }
    }
    func examine() async throws -> (String, Int) {
        let response = try await command("EXAMINE INBOX")
        var uidValidity: String?, total: Int?
        for line in response.lines {
            if let r = line.range(of: #"\[UIDVALIDITY [0-9]+\]"#, options: [.regularExpression, .caseInsensitive]) {
                let value = line[r].dropFirst().dropLast().split(separator: " ").last.map(String.init) ?? ""
                guard MailRules.number(value), uidValidity == nil else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; uidValidity = value
            }
            let parts = line.split(separator: " ")
            if parts.count == 3 && parts[0] == "*" && parts[2].uppercased() == "EXISTS" { guard let n = Int(parts[1]), n >= 0, n <= 2_147_483_647 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; total = n }
        }
        guard let uidValidity, let total else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; return (uidValidity, total)
    }
}

private enum MailText {
    static func decode(_ data: Data, charset: String) throws -> String {
        let encoding = CFStringConvertIANACharSetNameToEncoding(charset as CFString)
        guard encoding != kCFStringEncodingInvalidId,
              let value = String(data: data, encoding: String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(encoding))) else { throw WorkMailFailure.fail("MAIL_ENCODING") }
        return value
    }
    static func quotedPrintable(_ data: Data, header: Bool = false) throws -> Data {
        let bytes = Array(data); var out = Data(), at = 0
        func hex(_ b: UInt8) -> UInt8? { if (48...57).contains(b) { return b - 48 }; if (65...70).contains(b) { return b - 55 }; if (97...102).contains(b) { return b - 87 }; return nil }
        while at < bytes.count {
            let b = bytes[at]; at += 1
            if header && b == 95 { out.append(32) }
            else if b != 61 { out.append(b) }
            else if at + 1 < bytes.count && bytes[at] == 13 && bytes[at + 1] == 10 { at += 2 }
            else { guard at + 1 < bytes.count, let a = hex(bytes[at]), let b = hex(bytes[at + 1]) else { throw WorkMailFailure.fail("MAIL_ENCODING") }; out.append(a * 16 + b); at += 2 }
        }
        return out
    }
    static func base64(_ data: Data) throws -> Data {
        let clean = data.filter { ![9, 10, 13, 32].contains($0) }
        guard clean.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [43, 47, 61].contains($0) }),
              let value = Data(base64Encoded: clean) else { throw WorkMailFailure.fail("MAIL_ENCODING") }
        return value
    }
    static func encodedWords(_ text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: #"=\?([^?\s]{1,64})\?([bBqQ])\?([^?]{0,8192})\?="#) else { return text }
        let range = NSRange(text.startIndex..., in: text); var result = "", cursor = text.startIndex, priorEncoded = false
        for match in regex.matches(in: text, range: range) {
            guard let whole = Range(match.range, in: text), let a = Range(match.range(at: 1), in: text), let b = Range(match.range(at: 2), in: text), let c = Range(match.range(at: 3), in: text) else { continue }
            let gap = String(text[cursor..<whole.lowerBound])
            if !(priorEncoded && gap.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { result += gap }
            let raw = Data(text[c].utf8)
            if let bytes = try? (text[b].uppercased() == "B" ? base64(raw) : quotedPrintable(raw, header: true)), let value = try? decode(bytes, charset: String(text[a])) { result += value; priorEncoded = true }
            else { result += String(text[whole]); priorEncoded = false }
            cursor = whole.upperBound
        }
        result += text[cursor...]; return result
    }
    static func headers(_ data: Data) throws -> [String: String] {
        guard data.count <= MailRules.headerBytes, !data.contains(0), let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
        var fields: [String: String] = [:], current: String?
        for line in text.components(separatedBy: "\r\n") {
            if line.isEmpty { break }
            if line.hasPrefix(" ") || line.hasPrefix("\t") { guard let current else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }; fields[current, default: ""] += " " + line.trimmingCharacters(in: .whitespaces) }
            else {
                guard let colon = line.firstIndex(of: ":") else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                let key = line[..<colon].uppercased()
                guard !key.isEmpty, key.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) || $0 == 45 }), fields[key] == nil else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                current = key; fields[key] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            }
        }
        return fields.mapValues { String(decoding: encodedWords($0).utf16.prefix(4000), as: UTF16.self).replacingOccurrences(of: "\0", with: "") }
    }
    static func date(_ raw: String?) -> String? {
        guard let raw, raw.count <= 100 else { return nil }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "d-MMM-yyyy HH:mm:ss Z"
        guard let date = formatter.date(from: raw) else { return nil }; return ISO8601DateFormatter().string(from: date)
    }
    static func plainHTML(_ raw: String) -> String {
        var text = raw.replacingOccurrences(of: #"(?is)<(script|style)\b[^>]*>.*?</\1\s*>"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?is)<(?:br\b[^>]*|/p|/div|/li|/tr)>"#, with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?s)<[^>]*>"#, with: "", options: .regularExpression)
        if let regex = try? NSRegularExpression(pattern: #"&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));"#) {
            for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
                let hexadecimal = match.range(at: 1).location != NSNotFound
                if let digits = Range(match.range(at: hexadecimal ? 1 : 2), in: text), let whole = Range(match.range, in: text),
                   let number = UInt32(text[digits], radix: hexadecimal ? 16 : 10), let scalar = UnicodeScalar(number) {
                    text.replaceSubrange(whole, with: String(scalar))
                }
            }
        }
        for (a, b) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&apos;", "'"), ("&rsquo;", "’"), ("&lsquo;", "‘"), ("&ldquo;", "“"), ("&rdquo;", "”"), ("&mdash;", "—"), ("&ndash;", "–"), ("&hellip;", "…"), ("&amp;", "&")] { text = text.replacingOccurrences(of: a, with: b) }
        return text
    }
}
private struct MailBodyPart: Sendable {
    let section: String, charset: String, encoding: String, html: Bool, bytes: Int
    static func choose(_ structure: MailToken) throws -> MailBodyPart? {
        var visited = 0
        func visit(_ token: MailToken, path: String, depth: Int) throws -> [MailBodyPart] {
            visited += 1; guard visited <= 64, depth <= 8, let list = token.list, !list.isEmpty else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
            if list[0].list != nil {
                var index = 0
                while index < list.count && list[index].list != nil { index += 1 }
                guard index < list.count, list[index].atom != nil else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                if list.count > index + 2, list[index + 2].list?.first?.atom?.uppercased() == "ATTACHMENT" { return [] }
                var result: [MailBodyPart] = []
                for child in 0..<index { result += try visit(list[child], path: path.isEmpty ? "\(child + 1)" : path + ".\(child + 1)", depth: depth + 1) }
                return result
            }
            guard list.count >= 7, let type = list[0].atom?.uppercased(), let subtype = list[1].atom?.uppercased() else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
            guard type == "TEXT", ["PLAIN", "HTML"].contains(subtype), let encoding = list[5].atom,
                  let countText = list[6].atom, let bytes = Int(countText), bytes >= 0 else { return [] }
            var charset = "US-ASCII"
            if let params = list[2].list {
                guard params.count % 2 == 0 else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
                for n in stride(from: 0, to: params.count, by: 2) {
                    if params[n].atom?.uppercased() == "NAME" { return [] }
                    if params[n].atom?.uppercased() == "CHARSET", let value = params[n + 1].atom { charset = value }
                }
            }
            if list.count > 9, list[9].list?.first?.atom?.uppercased() == "ATTACHMENT" { return [] }
            return [MailBodyPart(section: path.isEmpty ? "1" : path, charset: charset, encoding: encoding, html: subtype == "HTML", bytes: bytes)]
        }
        let values = try visit(structure, path: "", depth: 0)
        return values.first(where: { !$0.html }) ?? values.first
    }
    func text(_ data: Data) throws -> (String, Bool) {
        let clipped = bytes > data.count
        var raw = data
        switch encoding.uppercased() {
        case "BASE64":
            if clipped { let clean = raw.filter { ![9, 10, 13, 32].contains($0) }; raw = Data(clean.prefix(clean.count - clean.count % 4)) }
            raw = try MailText.base64(raw)
        case "QUOTED-PRINTABLE":
            if clipped, let equal = raw.lastIndex(of: 61), raw.distance(from: equal, to: raw.endIndex) <= 3 { raw = Data(raw[..<equal]) }
            raw = try MailText.quotedPrintable(raw)
        case "7BIT", "8BIT", "BINARY": break
        default: throw WorkMailFailure.fail("MAIL_ENCODING")
        }
        var value: String?
        // A byte-limited UTF-8 excerpt may end in a partial scalar. Only when
        // server size proves truncation may up to three trailing bytes be cut.
        for cut in 0...(clipped ? min(3, raw.count) : 0) { if let text = try? MailText.decode(Data(raw.prefix(raw.count - cut)), charset: charset) { value = text; break } }
        guard let decoded = value else { throw WorkMailFailure.fail("MAIL_ENCODING") }
        let plain = html ? MailText.plainHTML(decoded) : decoded
        return (String(decoding: plain.utf16.prefix(32_000), as: UTF16.self).replacingOccurrences(of: "\0", with: ""), clipped || plain.utf16.count > 32_000)
    }
}

actor WorkMailClient {
    static let shared = WorkMailClient()
    private let metadata: MailMetadata
    private let credentials: any WorkMailCredentials
    private let factory: @Sendable (String) -> any WorkMailTransport
    private var busy = false
    init(directory: URL? = nil) {
        metadata = MailMetadata(directory: directory); credentials = MailKeychain()
        factory = { MailTLS(host: $0) }
    }
    #if WORK_MAIL_QA
    init(directory: URL, credentials: any WorkMailCredentials, transport: @escaping @Sendable (String) -> any WorkMailTransport) {
        metadata = MailMetadata(directory: directory); self.credentials = credentials; factory = transport
    }
    #endif
    func accounts() async throws -> [MailAccount] { try metadata.locked { try metadata.read($0).0.accounts } }
    private func session(_ account: MailAccount, password: String) async throws -> MailSession {
        guard let host = MailRules.hosts[account.provider] else { throw WorkMailFailure.fail("MAIL_INVALID_REQUEST") }
        let session = MailSession(factory(host))
        do { try await session.start(address: account.address, password: password); return session }
        catch { session.transport.close(); if Task.isCancelled { throw WorkMailFailure.fail("MAIL_CANCELLED") }; throw error }
    }
    func connect(provider: String, address: String, password: String) async throws -> MailAccount {
        guard !busy else { throw WorkMailFailure.fail("MAIL_BUSY") }; busy = true; defer { busy = false }
        let address = address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard MailRules.hosts[provider] != nil, MailRules.address(address), !password.isEmpty, password.utf8.count <= 256,
              password.utf8.allSatisfy({ $0 >= 32 && $0 < 127 }) else { throw WorkMailFailure.fail("MAIL_INVALID_REQUEST") }
        let before = try metadata.locked { try metadata.read($0) }
        let existing = before.0.accounts.first { $0.provider == provider && $0.address.lowercased() == address }
        guard existing != nil || before.0.accounts.count < 8 else { throw WorkMailFailure.fail("MAIL_TOO_LARGE") }
        let account = existing ?? MailAccount(id: UUID().uuidString.lowercased(), provider: provider, address: address, createdAt: MailRules.stamp())
        let connection = try await session(account, password: password); defer { connection.transport.close() }
        _ = try await connection.examine(); try Task.checkCancellation()
        return try metadata.locked { fd in
            var latest = try metadata.read(fd)
            guard latest.1 == before.1 else { throw WorkMailFailure.fail("MAIL_STORAGE_CHANGED") }
            try credentials.set(password, id: account.id)
            if existing != nil { return account }
            latest.0.accounts.append(account)
            do { try metadata.write(latest.0, expected: latest.1, fd: fd) }
            catch MailMetadata.PublishFailure.afterPublish { throw WorkMailFailure.fail("MAIL_STORAGE") }
            catch { do { try credentials.remove(account.id) } catch { throw WorkMailFailure.fail("MAIL_CREDENTIALS") }; throw WorkMailFailure.fail("MAIL_STORAGE") }
            return account
        }
    }
    func disconnect(accountID: String) async throws {
        guard !busy else { throw WorkMailFailure.fail("MAIL_BUSY") }; busy = true; defer { busy = false }
        guard MailRules.uuid(accountID) else { throw WorkMailFailure.fail("MAIL_INVALID_REQUEST") }
        try metadata.locked { fd in
            var current = try metadata.read(fd)
            guard let account = current.0.accounts.first(where: { $0.id.caseInsensitiveCompare(accountID) == .orderedSame }) else { throw WorkMailFailure.fail("MAIL_NOT_FOUND") }
            let oldPassword = try? credentials.read(account.id)
            try credentials.remove(account.id); current.0.accounts.removeAll { $0.id == account.id }
            do { try metadata.write(current.0, expected: current.1, fd: fd) }
            catch MailMetadata.PublishFailure.afterPublish { throw WorkMailFailure.fail("MAIL_STORAGE") }
            catch { if let oldPassword { try credentials.set(oldPassword, id: account.id) }; throw WorkMailFailure.fail("MAIL_STORAGE") }
        }
    }
    private func account(_ id: String) throws -> MailAccount {
        guard MailRules.uuid(id) else { throw WorkMailFailure.fail("MAIL_INVALID_REQUEST") }
        guard let value = try metadata.locked({ try metadata.read($0).0.accounts.first { $0.id.caseInsensitiveCompare(id) == .orderedSame } }) else { throw WorkMailFailure.fail("MAIL_NOT_FOUND") }; return value
    }
    private func row(_ fetch: MailFetch, account: MailAccount, validity: String) throws -> MailRow {
        guard let uid = fetch.uid, MailRules.number(uid), fetch.fields["FLAGS"]?.list != nil, let data = fetch.header else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
        let fields = try MailText.headers(data)
        return MailRow(accountID: account.id, provider: account.provider, uidValidity: validity, uid: uid,
                       subject: fields["SUBJECT"] ?? "", sender: fields["FROM"] ?? "",
                       receivedAt: MailText.date(fetch.fields["INTERNALDATE"]?.atom), messageID: fields["MESSAGE-ID"], unread: fetch.unread)
    }
    func inbox(accountID: String, beforeSequence: Int? = nil) async throws -> MailPage {
        guard !busy else { throw WorkMailFailure.fail("MAIL_BUSY") }; busy = true; defer { busy = false }
        if let beforeSequence, beforeSequence <= 1 { throw WorkMailFailure.fail("MAIL_INVALID_REQUEST") }
        let account = try account(accountID), connection = try await session(account, password: credentials.read(account.id)); defer { connection.transport.close() }
        return try await withTaskCancellationHandler(operation: {
            let (validity, total) = try await connection.examine()
            let upper = min(total, beforeSequence.map { $0 - 1 } ?? total)
            if upper == 0 { return MailPage(account: account, rows: [], nextBeforeSequence: nil, total: total, uidValidity: validity) }
            let lower = max(1, upper - 49)
            let response = try await connection.command("FETCH \(lower):\(upper) (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT MESSAGE-ID)])")
            guard response.fetches.count <= 50, Set(response.fetches.compactMap(\.uid)).count == response.fetches.count,
                  response.fetches.allSatisfy({ (lower...upper).contains($0.sequence) }) else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
            let rows = try response.fetches.sorted { $0.sequence > $1.sequence }.map { try row($0, account: account, validity: validity) }
            return MailPage(account: account, rows: rows, nextBeforeSequence: lower > 1 ? lower : nil, total: total, uidValidity: validity)
        }, onCancel: { connection.transport.close() })
    }
    func message(accountID: String, uidValidity: String, uid: String) async throws -> MailMessage {
        guard !busy else { throw WorkMailFailure.fail("MAIL_BUSY") }; busy = true; defer { busy = false }
        guard MailRules.number(uidValidity), MailRules.number(uid) else { throw WorkMailFailure.fail("MAIL_INVALID_REQUEST") }
        let account = try account(accountID), connection = try await session(account, password: credentials.read(account.id)); defer { connection.transport.close() }
        return try await withTaskCancellationHandler(operation: {
            let (validity, _) = try await connection.examine()
            guard validity == uidValidity else { throw WorkMailFailure.fail("MAIL_MAILBOX_CHANGED") }
            let response = try await connection.command("UID FETCH \(uid) (UID FLAGS INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT MESSAGE-ID)])")
            guard response.fetches.count == 1, let fetch = response.fetches.first, fetch.uid == uid else { throw WorkMailFailure.fail("MAIL_NOT_FOUND") }
            let row = try row(fetch, account: account, validity: validity)
            guard let structure = fetch.fields["BODYSTRUCTURE"] else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
            guard let part = try MailBodyPart.choose(structure) else { return MailMessage(row: row, bodyText: "", truncated: false) }
            if part.bytes == 0 { return MailMessage(row: row, bodyText: "", truncated: false) }
            let bodyResponse = try await connection.command("UID FETCH \(uid) (UID BODY.PEEK[\(part.section)]<0.\(MailRules.bodyBytes)>)")
            guard bodyResponse.fetches.count == 1, let item = bodyResponse.fetches.first, item.uid == uid,
                  let data = item.fields.first(where: { $0.key == "BODY[\(part.section)]" || $0.key == "BODY[\(part.section)]<0>" })?.value.literal else { throw WorkMailFailure.fail("MAIL_PROTOCOL") }
            let decoded = try part.text(data)
            return MailMessage(row: row, bodyText: decoded.0, truncated: decoded.1)
        }, onCancel: { connection.transport.close() })
    }
}
