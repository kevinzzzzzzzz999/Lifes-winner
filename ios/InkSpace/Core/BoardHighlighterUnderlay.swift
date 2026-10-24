import Foundation
import PencilKit

/// Opt-in presentation semantics for newly completed highlighter strokes.
/// The preference is independent from pen presets, layers and geometry aids.
struct BoardHighlighterUnderlaySettings: Codable, Equatable {
    static let defaultsKey = "InkSpace.highlighterUnderlay.v1"
    var isEnabled = false

    static func load(from defaults: UserDefaults = .standard) -> Self {
        guard let data = defaults.data(forKey: defaultsKey),
              let value = try? JSONDecoder().decode(Self.self, from: data) else { return Self() }
        return value
    }

    func save(to defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}

/// A bounded, stateless factory. It never reads preferences, touches a canvas,
/// rebuilds a PKStroke, or reorders pre-existing strokes against each other.
/// Call only after native tool-end and any held-line/shape transformation.
enum BoardHighlighterUnderlay {
    static let maximumStrokes = 50_000
    static let maximumCompletedSuffix = 128

    struct Change {
        let drawing: PKDrawing
        let sourceIndex: Int
        let destinationIndex: Int
    }

    /// Return nil when disabled, already beneath all ordinary ink, or when the
    /// expected baseline changed (erase, lasso, color, pressure or another pen).
    /// In every nil case the caller must leave the current drawing untouched.
    static func applying(to drawing: PKDrawing, after baseline: PKDrawing, enabled: Bool) -> Change? {
        guard enabled else { return nil }
        let current = drawing.strokes, previous = baseline.strokes
        guard current.count <= maximumStrokes, current.count == previous.count + 1,
              let newest = current.last, newest.ink.inkType == .marker, !newest.path.isEmpty,
              zip(current.dropLast(), previous).allSatisfy({ sameStroke($0.0, $0.1) }) else { return nil }
        // New highlighters stay over the leading highlighter run, and beneath
        // every ordinary stroke. Historical mixed order is otherwise preserved.
        guard let destination = previous.firstIndex(where: { $0.ink.inkType != .marker }) else { return nil }
        var reordered = previous
        reordered.insert(newest, at: destination)
        return Change(drawing: PKDrawing(strokes: reordered), sourceIndex: previous.count,
                      destinationIndex: destination)
    }

    struct CompletedSuffixChange {
        let drawing: PKDrawing
        let completedMarkerCount: Int
        let completedStrokeCount: Int
    }

    /// Complete a burst of native strokes without forcing the next Pencil-down
    /// to wait for a post-processing edit. All strokes before the captured
    /// baseline must still match exactly; erasure/lasso/pressure edits reject the
    /// transaction. Only newly appended markers move, retaining their order.
    static func applyingCompletedSuffix(to drawing: PKDrawing, after baseline: PKDrawing,
                                        enabled: Bool) -> CompletedSuffixChange? {
        guard enabled else { return nil }
        let current = drawing.strokes, previous = baseline.strokes
        let suffixCount = current.count - previous.count
        guard current.count <= maximumStrokes, (1...maximumCompletedSuffix).contains(suffixCount),
              zip(current.prefix(previous.count), previous).allSatisfy({ sameStroke($0.0, $0.1) }) else { return nil }
        let suffix = Array(current.suffix(suffixCount))
        guard suffix.allSatisfy({ !$0.path.isEmpty }) else { return nil }
        let markers = suffix.filter { $0.ink.inkType == .marker }
        guard !markers.isEmpty else { return nil }
        let destination = previous.firstIndex(where: { $0.ink.inkType != .marker }) ?? previous.count
        // No earlier ordinary ink means an already leading new-marker run is
        // correct. Do not register a correction that would not change stacking.
        if destination == previous.count {
            guard let ordinary = suffix.firstIndex(where: { $0.ink.inkType != .marker }),
                  let lastMarker = suffix.lastIndex(where: { $0.ink.inkType == .marker }),
                  ordinary < lastMarker else { return nil }
        }
        let ordinary = suffix.filter { $0.ink.inkType != .marker }
        var reordered: [PKStroke] = []
        reordered.reserveCapacity(current.count)
        reordered.append(contentsOf: previous.prefix(destination))
        reordered.append(contentsOf: markers)
        reordered.append(contentsOf: previous.dropFirst(destination))
        reordered.append(contentsOf: ordinary)
        return CompletedSuffixChange(drawing: PKDrawing(strokes: reordered),
            completedMarkerCount: markers.count, completedStrokeCount: suffixCount)
    }

    /// Compare native snapshots for the caller's transactional undo guards.
    /// PKDrawing identity differs after rebuilding; PKStroke native equality
    /// also omits transforms, so those and the pigment/mask are checked directly.
    static func hasSameStrokes(_ lhs: PKDrawing, _ rhs: PKDrawing) -> Bool {
        let left = lhs.strokes, right = rhs.strokes
        return left.count == right.count && zip(left, right).allSatisfy { sameStroke($0.0, $0.1) }
    }

    /// Chronological replay reveals a prefix in time order, but it must paint
    /// that prefix in saved native order. Build once with source indices before
    /// chronological sorting, then keep this small value beside the snapshot.
    struct ReplayOrder {
        private let paintOrder: [Int]
        let count: Int

        fileprivate init(paintOrder: [Int]) {
            self.paintOrder = paintOrder
            self.count = paintOrder.count
        }

        /// No preferences, dates, sorting, Set allocation or validation of all
        /// indices is performed per frame. Construction already checked them.
        func drawing(chronological strokes: [PKStroke], visibleCount: Int) -> PKDrawing? {
            guard strokes.count == count, visibleCount >= 0, visibleCount <= count else { return nil }
            return PKDrawing(strokes: paintOrder.compactMap { $0 < visibleCount ? strokes[$0] : nil })
        }
    }

    static func replayOrder(sourceIndices: [Int]) -> ReplayOrder? {
        guard sourceIndices.count <= maximumStrokes,
              sourceIndices.allSatisfy({ $0 >= 0 }), Set(sourceIndices).count == sourceIndices.count else { return nil }
        return ReplayOrder(paintOrder: sourceIndices.indices.sorted { sourceIndices[$0] < sourceIndices[$1] })
    }

    /// One-shot convenience. A playback host should cache replayOrder instead.
    /// Source indices may contain gaps for fully erased/empty strokes. Historical
    /// layers are preserved; markers are never globally reordered for replay.
    static func replayDrawing(chronological strokes: [PKStroke], sourceIndices: [Int],
                              visibleCount: Int) -> PKDrawing? {
        guard strokes.count == sourceIndices.count else { return nil }
        return replayOrder(sourceIndices: sourceIndices)?.drawing(chronological: strokes, visibleCount: visibleCount)
    }

    private static func sameStroke(_ lhs: PKStroke, _ rhs: PKStroke) -> Bool {
        guard lhs.transform == rhs.transform, lhs.randomSeed == rhs.randomSeed,
              lhs.ink.inkType == rhs.ink.inkType, lhs.ink.color == rhs.ink.color,
              lhs.path.count == rhs.path.count, lhs.path.creationDate == rhs.path.creationDate,
              (lhs as PKStrokeReference).isEqual(rhs as PKStrokeReference) else { return false }
        switch (lhs.mask, rhs.mask) {
        case (nil, nil): return true
        case (let left?, let right?): return left.cgPath == right.cgPath
        default: return false
        }
    }
}
