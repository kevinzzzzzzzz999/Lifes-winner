import Foundation

struct MediaSource: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var path: String
    var name: String
    var duration: Double
    var hasVideo: Bool
    var hasAudio: Bool
    var sha256: String? = nil
}
struct MediaClip: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var sourceID: UUID
    var start: Double
    var end: Double
    var speed: Double = 1
    var volume: Double = 1
    var transition: MediaTransition? = nil
    var duration: Double { (end - start) / speed }
}
struct MediaOutput: Codable, Equatable, Sendable {
    var kind = "video"
    var width = 1280
    var height = 720
    var fps = 30
}
struct MediaTransition: Codable, Equatable, Sendable {
    var kind = "dissolve"
    var duration: Double = 0.5
}
struct MediaOverlay: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var sourceID: UUID
    var start: Double
    var end: Double
    var speed: Double = 1
    var volume: Double = 1
    var at: Double = 0
    var x: Double = 0.65
    var y: Double = 0.05
    var width: Double = 0.3
    var height: Double = 0.3
    var opacity: Double = 1
    var duration: Double { (end - start) / speed }
}
struct MediaCaption: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var start: Double
    var end: Double
    var text: String
}
struct MediaCaptionStyle: Codable, Equatable, Sendable {
    var fontSize: Double = 32
    var textColor = "#FFFFFF"
    var backgroundOpacity: Double = 0.5
}
struct MediaProject: Codable, Identifiable, Equatable, Sendable {
    var schemaVersion = 2
    var id = UUID()
    var title = "Media project"
    var createdAt = ISO8601DateFormatter().string(from: Date())
    var updatedAt = ISO8601DateFormatter().string(from: Date())
    var sources: [MediaSource] = []
    var clips: [MediaClip] = []
    var output = MediaOutput()
    var overlays: [MediaOverlay] = []
    var captions: [MediaCaption] = []
    var captionStyle = MediaCaptionStyle()

    /// Mobile edits video projects only. Audio files and old projects are
    /// retained unchanged so they can still be played or continued on Mac.
    var supportsMobileEditing: Bool {
        guard output.kind == "video" else { return false }
        let videoIDs = Set(sources.filter(\.hasVideo).map(\.id))
        return clips.allSatisfy { videoIDs.contains($0.sourceID) }
            && overlays.allSatisfy { videoIDs.contains($0.sourceID) }
    }

    init() {}
    enum CodingKeys: String, CodingKey { case schemaVersion, id, title, createdAt, updatedAt, sources, clips, output, overlays, captions, captionStyle }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try c.decode(Int.self, forKey: .schemaVersion)
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        sources = try c.decode([MediaSource].self, forKey: .sources)
        clips = try c.decode([MediaClip].self, forKey: .clips)
        output = try c.decode(MediaOutput.self, forKey: .output)
        overlays = try c.decodeIfPresent([MediaOverlay].self, forKey: .overlays) ?? []
        captions = try c.decodeIfPresent([MediaCaption].self, forKey: .captions) ?? []
        captionStyle = try c.decodeIfPresent(MediaCaptionStyle.self, forKey: .captionStyle) ?? MediaCaptionStyle()
    }
    var clipStarts: [Double] {
        var cursor = 0.0
        return clips.enumerated().map { index, clip in
            let start = cursor
            cursor += clip.duration - (index < clips.count - 1 ? clip.transition?.duration ?? 0 : 0)
            return start
        }
    }
    var baseDuration: Double { zip(clipStarts, clips).map { $0 + $1.duration }.max() ?? 0 }
    var duration: Double { max(baseDuration, overlays.map { $0.at + $0.duration }.max() ?? 0) }

    /// The same linear envelopes are used for rendering and conservative mix headroom.
    func baseGain(index: Int, at time: Double) -> Double {
        let starts = clipStarts, clip = clips[index], start = starts[index], end = start + clip.duration
        guard time >= start, time < end else { return 0 }
        var gain = clip.volume
        if index > 0, let incoming = clips[index - 1].transition?.duration, incoming > 0 {
            gain *= min(1, max(0, (time - start) / incoming))
        }
        if index < clips.count - 1, let outgoing = clip.transition?.duration, outgoing > 0 {
            gain *= min(1, max(0, (end - time) / outgoing))
        }
        return gain
    }
    var audioHeadroom: Double {
        let starts = clipStarts, lookup = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
        let base = clips.enumerated().compactMap { index, clip -> (start: Double, end: Double, volume: Double, fadeIn: Double, fadeOut: Double)? in
            guard lookup[clip.sourceID]?.hasAudio == true else { return nil }
            return (starts[index], starts[index] + clip.duration, clip.volume,
                    index > 0 ? clips[index - 1].transition?.duration ?? 0 : 0,
                    index < clips.count - 1 ? clip.transition?.duration ?? 0 : 0)
        }
        let layers = overlays.filter { lookup[$0.sourceID]?.hasAudio == true }
        var points = [0.0]
        for item in base { points += [item.start, item.end, item.start + item.fadeIn, item.end - item.fadeOut] }
        for layer in layers { points += [layer.at, layer.at + layer.duration] }
        var peak = 1.0
        for edge in points {
            for time in [edge, max(0, edge - 0.000001)] {
                let baseGain = base.reduce(0.0) { sum, item in
                    guard time >= item.start, time < item.end else { return sum }
                    let incoming = item.fadeIn > 0 ? min(1, max(0, (time - item.start) / item.fadeIn)) : 1
                    let outgoing = item.fadeOut > 0 ? min(1, max(0, (item.end - time) / item.fadeOut)) : 1
                    return sum + item.volume * incoming * outgoing
                }
                let layerGain = layers.reduce(0.0) { $0 + (time >= $1.at && time < $1.at + $1.duration ? $1.volume : 0) }
                peak = max(peak, baseGain + layerGain)
            }
        }
        return 1 / peak
    }

    func validate() throws {
        guard [1, 2].contains(schemaVersion), title.utf8.count <= 1000, sources.count <= 200, clips.count <= 500,
              overlays.count <= 24, captions.count <= 1000,
              Set(sources.map(\.id)).count == sources.count, Set(clips.map(\.id)).count == clips.count,
              Set(overlays.map(\.id)).count == overlays.count, Set(captions.map(\.id)).count == captions.count,
              ["video", "audio"].contains(output.kind), output.fps == 30,
              (output.width == 1280 && output.height == 720 || output.width == 1920 && output.height == 1080)
        else { throw MediaEditError.invalidProject }
        for source in sources {
            let parts = source.path.split(separator: "/", omittingEmptySubsequences: false)
            guard !source.path.hasPrefix("/"), !source.path.contains("\\"), !source.path.contains(":"),
                  !source.path.contains("\0"), !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  source.path.utf8.count <= 8192, source.name.utf8.count <= 1000,
                  source.duration.isFinite, source.duration > 0, source.duration <= 43_200,
                  source.hasVideo || source.hasAudio,
                  source.sha256 == nil || source.sha256!.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil
            else { throw MediaEditError.invalidProject }
        }
        let lookup = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
        func validRange(_ sourceID: UUID, _ start: Double, _ end: Double, _ speed: Double, _ volume: Double) -> Bool {
            guard let source = lookup[sourceID] else { return false }
            return [start, end, speed, volume].allSatisfy(\.isFinite) && start >= 0 && end > start && end <= source.duration + 0.001
                && (0.25...4).contains(speed) && (0...1).contains(volume)
        }
        for (index, clip) in clips.enumerated() {
            guard validRange(clip.sourceID, clip.start, clip.end, clip.speed, clip.volume) else { throw MediaEditError.invalidProject }
            if let transition = clip.transition {
                guard transition.kind == "dissolve", transition.duration.isFinite, transition.duration > 0,
                      transition.duration <= 5 else { throw MediaEditError.invalidProject }
                if index < clips.count - 1 {
                    guard transition.duration <= min(clip.duration / 2, clips[index + 1].duration / 2) else { throw MediaEditError.invalidProject }
                }
            }
        }
        for overlay in overlays {
            guard validRange(overlay.sourceID, overlay.start, overlay.end, overlay.speed, overlay.volume),
                  [overlay.at, overlay.x, overlay.y, overlay.width, overlay.height, overlay.opacity].allSatisfy(\.isFinite),
                  overlay.at >= 0, (0...1).contains(overlay.opacity), overlay.x >= 0, overlay.y >= 0,
                  overlay.width > 0, overlay.height > 0, overlay.x + overlay.width <= 1.0000001, overlay.y + overlay.height <= 1.0000001
            else { throw MediaEditError.invalidProject }
        }
        guard duration.isFinite, duration <= 43_200 else { throw MediaEditError.invalidProject }
        var previousEnd = 0.0
        for cue in captions {
            guard cue.start.isFinite, cue.end.isFinite, cue.start >= previousEnd, cue.end > cue.start, cue.end <= duration + 0.000001,
                  !cue.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, cue.text.count <= 1000, !cue.text.contains("\0") else { throw MediaEditError.invalidProject }
            previousEnd = cue.end
        }
        guard captionStyle.fontSize.isFinite, (16...72).contains(captionStyle.fontSize),
              captionStyle.textColor.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil,
              captionStyle.backgroundOpacity.isFinite, (0...1).contains(captionStyle.backgroundOpacity) else { throw MediaEditError.invalidProject }
        var events: [(Double, Int)] = []
        for (index, clip) in clips.enumerated() where lookup[clip.sourceID]?.hasVideo == true {
            events += [(clipStarts[index], 1), (clipStarts[index] + clip.duration, -1)]
        }
        for overlay in overlays where lookup[overlay.sourceID]?.hasVideo == true { events += [(overlay.at, 1), (overlay.at + overlay.duration, -1)] }
        var active = 0
        for (_, delta) in events.sorted(by: { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }) {
            active += delta
            guard active <= 8 else { throw MediaEditError.invalidProject }
        }
    }
}

enum MediaEditError: LocalizedError {
    case invalidProject, unsupported, audioRequiresMac, sourceChanged(String), cancelled, exportFailed(String), existingFile
    var errorDescription: String? {
        let zh = Locale.preferredLanguages.first?.hasPrefix("zh") == true
        switch self {
        case .invalidProject: return zh ? "剪辑工程无效：请检查片段范围、素材路径和输出设置。" : "Invalid project: check clip ranges, source paths and output settings."
        case .audioRequiresMac: return zh ? "音频剪辑仅在 Mac 提供。请选择视频；原音频文件保留。" : "Audio editing is available on Mac. Choose a video; the original audio is preserved."
        case .unsupported: return zh ? "无法读取此音视频，或没有可导出的片段。" : "This media is unreadable, or there are no clips to export."
        case .sourceChanged(let name): return zh ? "素材已改变或不可读，请重新导入：\(name)" : "Source changed or is unavailable. Import it again: \(name)"
        case .cancelled: return zh ? "已取消导出，原素材保留。" : "Export cancelled. Original media is preserved."
        case .exportFailed(let reason): return zh ? "导出未完成：\(reason)" : "Export failed: \(reason)"
        case .existingFile: return zh ? "目标文件已存在，请另选文件名。" : "The output file already exists. Choose a new name."
        }
    }
}
