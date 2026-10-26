import Foundation

// Audio-time replacement, not string de-duplication. Finalized audio cannot be
// replaced by a later hypothesis (SpeechModuleResult's finalization contract).
struct DictationTranscript {
    struct TimedText { let start: Double; let end: Double; let text: String }
    struct Segment { let start: Double; let end: Double; let text: String; var final: Bool; let ordinal: Int }
    private(set) var segments: [Segment] = []
    private(set) var rejectionReason: String?
    private var ordinal = 0
    private var finalizedThrough = 0.0
    private let epsilon = 0.0000001
    @discardableResult
    mutating func receive(start: Double, end: Double, text: String, final: Bool, finalizationTime: Double? = nil, pieces: [TimedText] = []) -> Bool {
        rejectionReason=nil
        guard start.isFinite, end.isFinite, start >= 0, end >= start else { rejectionReason="invalid-range";return false }
        let supplied = !pieces.isEmpty
        let parts = supplied ? pieces : (text.isEmpty ? [] : [TimedText(start:start,end:end,text:text)])
        guard parts.map(\.text).joined() == text,
              parts.allSatisfy({ $0.start.isFinite && $0.end.isFinite && $0.start >= start-epsilon && $0.end <= end+epsilon && $0.end >= $0.start }) else { rejectionReason="invalid-pieces";return false }
        // An exact repeated final event is harmless. Never collapse repeated
        // spoken words at distinct times by comparing their text.
        if final, !parts.isEmpty, parts.allSatisfy({ part in segments.contains { $0.final && abs($0.start-part.start)<epsilon && abs($0.end-part.end)<epsilon && $0.text==part.text } }) { return true }
        func overlaps(_ a: Double, _ b: Double) -> Bool {
            if end-start <= epsilon { return b-a <= epsilon && abs(a-start)<epsilon }
            return a < end-epsilon && start < b-epsilon
        }
        // Such an event would violate Apple's finalized-range contract. Keep
        // the finalized text and let the caller report an unsafe sequence.
        if segments.contains(where: { $0.final && overlaps($0.start,$0.end) }) { rejectionReason="final-overlap";return false }
        // If an existing timed piece straddles the replacement boundary, it
        // cannot be split honestly, even when the new event has word times.
        // Do not invent a character/time ratio or silently erase its prefix.
        // Apple may emit one broad provisional run (including trailing silence),
        // then finalize a shorter prefix with actual word ranges. That final
        // prefix is authoritative; retire the overlapping provisional tail.
        // A missing LEFT prefix is still unsafe to split and remains deferred.
        if segments.contains(where: { !$0.final && overlaps($0.start,$0.end) && ($0.start < start-epsilon || (!final && $0.end > end+epsilon)) }) { rejectionReason="volatile-boundary";return false }
        segments.removeAll { !$0.final && overlaps($0.start,$0.end) }
        for part in parts where !part.text.isEmpty {
            ordinal += 1
            segments.append(Segment(start:part.start,end:part.end,text:part.text,final:final,ordinal:ordinal))
        }
        if let time=finalizationTime, time.isFinite, time>=0 { finalizedThrough=max(finalizedThrough,time) }
        if final { finalizedThrough=max(finalizedThrough,end) }
        for index in segments.indices where segments[index].end <= finalizedThrough+epsilon { segments[index].final=true }
        segments.sort { $0.start == $1.start ? $0.ordinal < $1.ordinal : $0.start < $1.start }
        return true
    }
    var text: String { segments.map(\.text).joined() }
}

// Shared by the tap and the main-actor watchdog. No audio is retained here.
final class DictationAudioReadiness: @unchecked Sendable {
    private let lock=NSLock()
    private var valid=true
    private var first=false
    private var lastFrame: Double
    init(startedAt: Double) { lastFrame=startedAt }
    func receivedFrame(at now: Double) -> Bool {
        lock.lock();defer{lock.unlock()};guard valid else{return false}
        lastFrame=now;let isFirst = !first;first=true;return isFirst
    }
    func timedOut(at now: Double, seconds: Double=5) -> Bool {
        lock.lock();defer{lock.unlock()};return valid && now-lastFrame>=seconds
    }
    func invalidate(){lock.lock();valid=false;lock.unlock()}
}
