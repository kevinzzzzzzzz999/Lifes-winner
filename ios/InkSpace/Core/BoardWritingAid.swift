import Foundation
import CoreGraphics

struct BoardWritingAidSessionToken: Equatable, Sendable {
    var sessionID: UUID
    var generation: Int
    var viewportRevision: Int
}

struct BoardWritingAidTextSubmission: Equatable, Sendable {
    var token: BoardWritingAidSessionToken
    var text: String
    var fontSize: Double
    var worldAnchor: BoardWritingAidPoint
}

/// A temporary input choice. Deliberately never saved as an enabled preference.
enum BoardWritingAidMode: String, CaseIterable, Identifiable, Sendable {
    case off, laser, wavy, fill, tape, scribble
    var id: String { rawValue }
    var title: String {
        switch self {
        case .off: String(localized: "辅助笔已关闭")
        case .laser: String(localized: "激光演示")
        case .wavy: String(localized: "波浪线")
        case .fill: String(localized: "闭合填色")
        case .tape: String(localized: "遮挡胶带")
        case .scribble: String(localized: "手写转文字")
        }
    }
}

struct BoardWritingAidSettings: Codable, Equatable, Sendable {
    static let defaultsKey = "InkSpace.writingAid.settings.v1"
    static let fontSizeRange = 12.0...72.0
    static let pauseDurationRange = 0.4...3.0
    var fontSize: Double = 24
    var pauseDuration: Double = 1.2
    var automaticallyCreatesText = false
    var laserFadeDuration: Double = 0.8

    var normalized: Self {
        var result = self
        result.fontSize = fontSize.isFinite ? min(72, max(12, fontSize)) : 24
        result.pauseDuration = pauseDuration.isFinite ? min(3, max(0.4, pauseDuration)) : 1.2
        result.laserFadeDuration = laserFadeDuration.isFinite ? min(2, max(0.25, laserFadeDuration)) : 0.8
        return result
    }
    static func load(from defaults: UserDefaults = .standard) -> Self {
        guard let bytes = defaults.data(forKey: defaultsKey),
              let value = try? JSONDecoder().decode(Self.self, from: bytes) else { return Self() }
        return value.normalized
    }
    func save(to defaults: UserDefaults = .standard) {
        guard let bytes = try? JSONEncoder().encode(normalized) else { return }
        defaults.set(bytes, forKey: Self.defaultsKey)
    }
}

struct BoardWritingAidPoint: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
    init(_ point: CGPoint) { x = point.x; y = point.y }
    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
}

struct BoardWritingAidColor: Codable, Equatable, Sendable {
    var red: Double
    var green: Double
    var blue: Double
    var alpha: Double
    var isValid: Bool { [red, green, blue, alpha].allSatisfy { $0.isFinite && (0...1).contains($0) } }
}

struct BoardWritingAidTape: Codable, Equatable, Identifiable, Sendable {
    var id: UUID = UUID()
    var points: [BoardWritingAidPoint]
    var width: Double
    var color: BoardWritingAidColor
    var isRevealed = false
    /// Reserved for an explicit host-owned card attachment. Nil is board space.
    /// Hosts that cannot resolve an attachment must not silently move the tape.
    var anchorItemID: UUID? = nil

    func validate(worldSize: CGSize = CGSize(width: 8_000_000, height: 8_000_000)) throws {
        guard anchorItemID == nil else { throw BoardWritingAidFailure.unsupportedVersion }
        guard (1...4096).contains(points.count), width.isFinite, width > 0, width <= 4096,
              color.isValid, worldSize.width.isFinite, worldSize.height.isFinite,
              worldSize.width > 0, worldSize.height > 0,
              points.allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.x >= width / 2 && $0.y >= width / 2
                && $0.x + width / 2 <= worldSize.width && $0.y + width / 2 <= worldSize.height }) else {
            throw BoardWritingAidFailure.invalidGeometry
        }
    }
}

/// This sidecar owns only masks; source ink and the board format stay independent.
struct BoardWritingAidTapeDocument: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let maximumBytes = 4 * 1024 * 1024
    static let maximumTapes = 500
    static let maximumPoints = 200_000
    var version: Int = Self.currentVersion
    var boardID: UUID
    var revision: UInt64 = 0
    var tapes: [BoardWritingAidTape] = []

    func validate() throws {
        guard version == Self.currentVersion else { throw BoardWritingAidFailure.unsupportedVersion }
        guard tapes.count <= Self.maximumTapes, Set(tapes.map(\.id)).count == tapes.count,
              tapes.reduce(0, { $0 + $1.points.count }) <= Self.maximumPoints else {
            throw BoardWritingAidFailure.tooComplex
        }
        try tapes.forEach { try $0.validate() }
    }
    func toggling(_ id: UUID) throws -> Self {
        try validate()
        guard let index = tapes.firstIndex(where: { $0.id == id }) else { throw BoardWritingAidFailure.changedSession }
        var next = self; next.tapes[index].isRevealed.toggle(); return next
    }
}

enum BoardWritingAidFailure: Error, LocalizedError {
    case invalidGeometry, tooComplex, notClosed, changedSession, unsupportedVersion, wrongBoard, revisionConflict, unsafeLocation, unavailable
    var errorDescription: String? {
        switch self {
        case .invalidGeometry: String(localized: "辅助笔范围无效或超出白板，请重新绘制。")
        case .tooComplex: String(localized: "辅助笔内容过大，请缩小范围或减少胶带。")
        case .notClosed: String(localized: "请画出闭合轮廓，再抬笔填色。")
        case .changedSession: String(localized: "画布或模式已改变，本次辅助笔操作未提交。")
        case .unsupportedVersion: String(localized: "胶带文件版本较新，已保留原文件，不能在此版本修改。")
        case .wrongBoard: String(localized: "胶带文件与当前白板不匹配，原文件已保留。")
        case .revisionConflict: String(localized: "胶带已在其他窗口改变，请重新载入后再修改。")
        case .unsafeLocation: String(localized: "胶带保存位置不可用或包含符号链接，原文件已保留。")
        case .unavailable: String(localized: "胶带文件无法读取或保存，请检查仓库授权后重试。")
        }
    }
}
