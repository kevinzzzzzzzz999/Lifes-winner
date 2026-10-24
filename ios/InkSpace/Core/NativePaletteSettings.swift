import Foundation

/// User-controlled items in the native floating palette. The always-available
/// management item is supplied by the canvas and is not part of this list.
enum NativePaletteEntry: Codable, Equatable, Identifiable {
    case pen(UUID)
    case eraser
    case lasso
    case ruler

    static let utilities: [NativePaletteEntry] = [.eraser, .lasso, .ruler]

    var id: String {
        switch self {
        case .pen(let id): "inkspace.savedPen.\(id.uuidString)"
        case .eraser: "inkspace.palette.eraser"
        case .lasso: "inkspace.palette.lasso"
        case .ruler: "inkspace.palette.ruler"
        }
    }

    var penID: UUID? { if case .pen(let id) = self { id } else { nil } }
    var isUtility: Bool { penID == nil }

    private enum CodingKeys: String, CodingKey { case kind, penID }
    private enum Kind: String, Codable { case pen, eraser, lasso, ruler }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .pen: self = .pen(try values.decode(UUID.self, forKey: .penID))
        case .eraser: self = .eraser
        case .lasso: self = .lasso
        case .ruler: self = .ruler
        }
        if isUtility && values.contains(.penID) { throw NativePaletteSettingsError.invalidSettings }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .pen(let id):
            try values.encode(Kind.pen, forKey: .kind)
            try values.encode(id, forKey: .penID)
        case .eraser: try values.encode(Kind.eraser, forKey: .kind)
        case .lasso: try values.encode(Kind.lasso, forKey: .kind)
        case .ruler: try values.encode(Kind.ruler, forKey: .kind)
        }
    }
}

struct NativePaletteSettings: Codable, Equatable {
    static let defaultsKey = "InkSpace.nativePalette.v1"
    static let unreadableBackupKey = "InkSpace.nativePalette.v1.unreadable"
    var version = 1
    var entries: [NativePaletteEntry]

    static func migrated(penIDs: [UUID]) -> NativePaletteSettings {
        // Keep frequently used utilities near the first pen on initial upgrade.
        // Existing persisted mixed orders never pass through this migration.
        guard let first = penIDs.first else { return NativePaletteSettings(entries: NativePaletteEntry.utilities) }
        return NativePaletteSettings(entries: [.pen(first)] + NativePaletteEntry.utilities + penIDs.dropFirst().map(NativePaletteEntry.pen))
    }

    func validate() throws {
        guard version == 1, Set(entries.map(\.id)).count == entries.count else {
            throw NativePaletteSettingsError.invalidSettings
        }
    }

    /// Existing utility omissions are intentional. Only genuinely new pens are
    /// inserted; utilities are added automatically solely during first migration.
    func reconciled(penIDs: [UUID]) throws -> NativePaletteSettings {
        try validate()
        guard Set(penIDs).count == penIDs.count else { throw NativePaletteSettingsError.invalidSettings }
        let available = Set(penIDs)
        var result = self
        result.entries.removeAll { entry in entry.penID.map { !available.contains($0) } ?? false }
        let installed = Set(result.entries.compactMap(\.penID))
        let added = penIDs.filter { !installed.contains($0) }.map(NativePaletteEntry.pen)
        let insertion = result.entries.lastIndex { $0.penID != nil }.map { $0 + 1 } ?? 0
        result.entries.insert(contentsOf: added, at: insertion)
        return result
    }

    /// Legacy pen-only ordering changes replace just the pen slots in the mixed
    /// list. Eraser, lasso and ruler retain their positions relative to those slots.
    func reorderingPens(penIDs: [UUID]) throws -> NativePaletteSettings {
        var result = try reconciled(penIDs: penIDs)
        var index = 0
        result.entries = result.entries.map { entry in
            guard entry.penID != nil else { return entry }
            defer { index += 1 }
            return .pen(penIDs[index])
        }
        return result
    }

    func removing(_ entry: NativePaletteEntry) -> NativePaletteSettings {
        var result = self
        result.entries.removeAll { $0 == entry }
        return result
    }

    func restoringUtility(_ entry: NativePaletteEntry) -> NativePaletteSettings {
        guard entry.isUtility, !entries.contains(entry) else { return self }
        var result = self
        result.entries.append(entry)
        return result
    }

    func moving(fromOffsets offsets: IndexSet, toOffset destination: Int) throws -> NativePaletteSettings {
        try validate()
        guard (0...entries.count).contains(destination), offsets.allSatisfy({ entries.indices.contains($0) }) else {
            throw NativePaletteSettingsError.invalidMove
        }
        var result = self
        let moving = offsets.sorted().map { entries[$0] }
        result.entries = entries.enumerated().filter { !offsets.contains($0.offset) }.map(\.element)
        let insertion = destination - offsets.filter { $0 < destination }.count
        result.entries.insert(contentsOf: moving, at: insertion)
        return result
    }

    static func load(penIDs: [UUID], from defaults: UserDefaults = .standard) throws -> NativePaletteSettings {
        if let data = defaults.data(forKey: defaultsKey) {
            let original = try JSONDecoder().decode(Self.self, from: data)
            let value = try original.reconciled(penIDs: penIDs)
            if value != original { try value.save(to: defaults) }
            return value
        }
        let value = try migrated(penIDs: penIDs).reconciled(penIDs: penIDs)
        try value.save(to: defaults)
        return value
    }

    func save(to defaults: UserDefaults = .standard) throws {
        try validate()
        let data = try JSONEncoder().encode(self)
        defaults.set(data, forKey: Self.defaultsKey)
    }
}

enum NativePaletteSettingsError: LocalizedError {
    case invalidSettings
    case invalidMove

    var errorDescription: String? {
        switch self {
        case .invalidSettings: String(localized: "原生笔栏设置无效，原设置已保留。")
        case .invalidMove: String(localized: "笔栏顺序已变化，请重试。")
        }
    }
}
