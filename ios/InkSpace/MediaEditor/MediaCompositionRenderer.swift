import AVFoundation
import UIKit
import CoreImage

/// One effect engine for exports and temporary composition previews.
@MainActor enum MediaCompositionRenderer {
    struct Result {
        let composition: AVMutableComposition
        let audioMix: AVMutableAudioMix
        let videoComposition: AVMutableVideoComposition?
    }
    static func build(project: MediaProject, assets: [UUID: AVURLAsset], silence: AVAssetTrack,
                      black: AVAssetTrack?, checkCancellation: () throws -> Void) async throws -> Result {
        let composition = AVMutableComposition()
        let frame = CGSize(width: project.output.width, height: project.output.height)
        let total = time(project.duration)
        var audioParameters: [AVAudioMixInputParameters] = []
        var videoLayers: [MediaVideoLayer] = []
        var carrierID: CMPersistentTrackID = kCMPersistentTrackID_Invalid
        let headroom = project.audioHeadroom
        // A quiet full-duration carrier keeps gaps and audio-only tails present.
        guard let bed = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaEditError.unsupported }
        var cursor = CMTime.zero
        while cursor < total {
            try checkCancellation()
            let length = CMTimeMinimum(CMTimeSubtract(total, cursor), time(60))
            try bed.insertTimeRange(CMTimeRange(start: .zero, duration: length), of: silence, at: cursor)
            cursor = CMTimeAdd(cursor, length)
        }
        let mute = AVMutableAudioMixInputParameters(track: bed); mute.setVolume(0, at: .zero); audioParameters.append(mute)
        if let black {
            guard let carrier = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaEditError.unsupported }
            try carrier.insertTimeRange(CMTimeRange(start: .zero, duration: time(1)), of: black, at: .zero)
            carrier.scaleTimeRange(CMTimeRange(start: .zero, duration: time(1)), toDuration: total)
            carrierID = carrier.trackID
        }
        struct Segment {
            var sourceID: UUID; var start: Double; var end: Double; var speed: Double; var volume: Double
            var at: Double; var rect: CGRect; var opacity: Float; var fadeIn: Double; var fadeOut: Double; var order: Int
        }
        let starts = project.clipStarts
        var segments = project.clips.enumerated().map { i, clip in
            Segment(sourceID: clip.sourceID, start: clip.start, end: clip.end, speed: clip.speed, volume: clip.volume,
                    at: starts[i], rect: CGRect(origin: .zero, size: frame), opacity: 1,
                    fadeIn: i > 0 ? project.clips[i - 1].transition?.duration ?? 0 : 0,
                    fadeOut: i < project.clips.count - 1 ? clip.transition?.duration ?? 0 : 0, order: i)
        }
        segments += project.overlays.enumerated().map { i, layer in
            Segment(sourceID: layer.sourceID, start: layer.start, end: layer.end, speed: layer.speed, volume: layer.volume,
                    at: layer.at, rect: CGRect(x: layer.x * frame.width, y: layer.y * frame.height,
                                             width: layer.width * frame.width, height: layer.height * frame.height),
                    opacity: Float(layer.opacity), fadeIn: 0, fadeOut: 0, order: project.clips.count + i)
        }
        for segment in segments {
            try checkCancellation()
            guard let asset = assets[segment.sourceID] else { throw MediaEditError.invalidProject }
            let requested = CMTimeRange(start: time(segment.start), duration: time(segment.end - segment.start))
            let duration = (segment.end - segment.start) / segment.speed
            if let source = try await asset.loadTracks(withMediaType: .audio).first {
                let range = CMTimeRangeGetIntersection(requested, otherRange: try await source.load(.timeRange))
                if range.duration.seconds > 0 {
                    guard let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaEditError.unsupported }
                    let at = segment.at + (range.start.seconds - segment.start) / segment.speed
                    try track.insertTimeRange(range, of: source, at: time(at))
                    track.scaleTimeRange(CMTimeRange(start: time(at), duration: range.duration), toDuration: time(range.duration.seconds / segment.speed))
                    let mix = AVMutableAudioMixInputParameters(track: track)
                    let gain = Float(segment.volume * headroom)
                    mix.setVolume(gain, at: time(segment.at))
                    if segment.fadeIn > 0 {
                        mix.setVolumeRamp(fromStartVolume: 0, toEndVolume: gain,
                                          timeRange: CMTimeRange(start: time(segment.at), duration: time(segment.fadeIn)))
                    }
                    if segment.fadeOut > 0 {
                        mix.setVolumeRamp(fromStartVolume: gain, toEndVolume: 0,
                                          timeRange: CMTimeRange(start: time(segment.at + duration - segment.fadeOut), duration: time(segment.fadeOut)))
                    }
                    audioParameters.append(mix)
                }
            }
            if project.output.kind == "video" {
                let isBase = segment.order < project.clips.count
                let source = try await asset.loadTracks(withMediaType: .video).first
                if source == nil && !isBase { continue }
                var trackID: CMPersistentTrackID?, mediaStart = segment.at, mediaEnd = segment.at
                var transform = CGAffineTransform.identity
                if let source {
                    let range = CMTimeRangeGetIntersection(requested, otherRange: try await source.load(.timeRange))
                    if range.duration.seconds > 0 {
                        guard let track = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw MediaEditError.unsupported }
                        let at = segment.at + (range.start.seconds - segment.start) / segment.speed
                        let length = range.duration.seconds / segment.speed
                        try track.insertTimeRange(range, of: source, at: time(at))
                        track.scaleTimeRange(CMTimeRange(start: time(at), duration: range.duration), toDuration: time(length))
                        let natural = try await source.load(.naturalSize), original = try await source.load(.preferredTransform)
                        let bounds = CGRect(origin: .zero, size: natural).applying(original)
                        guard bounds.width > 0, bounds.height > 0 else { throw MediaEditError.unsupported }
                        let scale = min(segment.rect.width / bounds.width, segment.rect.height / bounds.height)
                        let topLeft = original.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
                            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
                            .concatenating(CGAffineTransform(translationX: segment.rect.minX + (segment.rect.width - bounds.width * scale) / 2,
                                                           y: segment.rect.minY + (segment.rect.height - bounds.height * scale) / 2))
                        // Pixel buffers/CI use lower-left coordinates; project geometry uses upper-left.
                        transform = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: natural.height)
                            .concatenating(topLeft).concatenating(CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: frame.height))
                        trackID = track.trackID; mediaStart = at; mediaEnd = at + length
                    }
                }
                videoLayers.append(MediaVideoLayer(trackID: trackID, mediaStart: mediaStart, mediaEnd: mediaEnd,
                                                   start: segment.at, end: segment.at + duration, opacity: segment.opacity,
                                                   fadeIn: segment.fadeIn, isBase: isBase, order: segment.order, transform: transform))
            }
        }

        let audioMix = AVMutableAudioMix(); audioMix.inputParameters = audioParameters
        guard project.output.kind == "video" else { return Result(composition: composition, audioMix: audioMix, videoComposition: nil) }
        let video = AVMutableVideoComposition()
        video.customVideoCompositorClass = MediaVideoCompositor.self
        video.renderSize = frame; video.frameDuration = CMTime(value: 1, timescale: Int32(project.output.fps))
        let captions = try await rasterCaptions(project: project, size: frame, checkCancellation: checkCancellation)
        var boundaries = Set([0.0, project.duration])
        for layer in videoLayers { boundaries.formUnion([layer.start, layer.end, layer.mediaStart, layer.mediaEnd]) }
        let edges = boundaries.sorted()
        var instructions: [AVVideoCompositionInstructionProtocol] = []
        for index in 0..<(edges.count - 1) {
            let start = edges[index], end = edges[index + 1]
            guard end > start else { continue }
            let layers = videoLayers.filter { $0.start <= start + 0.0000001 && $0.end >= end - 0.0000001 }.sorted { $0.order < $1.order }
            let required = layers.filter { $0.mediaStart <= start + 0.0000001 && $0.mediaEnd >= end - 0.0000001 }.compactMap(\.trackID)
            instructions.append(MediaVideoInstruction(timeRange: CMTimeRange(start: time(start), duration: time(end - start)),
                                                       tracks: [carrierID] + required, layers: layers, captions: captions, size: frame))
        }
        video.instructions = instructions
        return Result(composition: composition, audioMix: audioMix, videoComposition: video)
    }
    private static func time(_ value: Double) -> CMTime { CMTime(seconds: value, preferredTimescale: 600_000) }

    private static func rasterCaptions(project: MediaProject, size: CGSize, checkCancellation: () throws -> Void) async throws -> [MediaRasterCaption] {
        let rgb = UInt32(project.captionStyle.textColor.dropFirst(), radix: 16) ?? 0xFFFFFF
        let color = UIColor(red: CGFloat((rgb >> 16) & 255) / 255, green: CGFloat((rgb >> 8) & 255) / 255, blue: CGFloat(rgb & 255) / 255, alpha: 1)
        let width = size.width * 0.84, padding = size.height / 60
        var result: [MediaRasterCaption] = []
        for cue in project.captions {
            try checkCancellation()
            let raster: MediaRasterCaption = autoreleasepool {
            var displayText = cue.text
            var font = UIFont.systemFont(ofSize: project.captionStyle.fontSize * size.height / 720, weight: .semibold)
            let paragraph = NSMutableParagraphStyle(); paragraph.alignment = .center; paragraph.lineBreakMode = .byWordWrapping
            func height(_ font: UIFont) -> CGFloat {
                (displayText as NSString).boundingRect(with: CGSize(width: width - padding * 2, height: .greatestFiniteMagnitude),
                                                   options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font, .paragraphStyle: paragraph], context: nil).height.rounded(.up)
            }
            while height(font) > size.height * 0.45, font.pointSize > 10 { font = font.withSize(font.pointSize - 1) }
            if height(font) > size.height * 0.45 {
                displayText = displayText.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                paragraph.lineBreakMode = .byCharWrapping
            }
            let boxHeight = min(size.height * 0.6, height(font) + padding * 2)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = false
            let bitmapSize = CGSize(width: width, height: boxHeight)
            let image = UIGraphicsImageRenderer(size: bitmapSize, format: format).image { _ in
                UIColor.black.withAlphaComponent(project.captionStyle.backgroundOpacity).setFill()
                UIBezierPath(roundedRect: CGRect(origin: .zero, size: bitmapSize), cornerRadius: padding / 2).fill()
                (displayText as NSString).draw(in: CGRect(x: padding, y: padding, width: width - padding * 2, height: boxHeight - padding * 2),
                                           withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
            }
            return MediaRasterCaption(id: cue.id, start: cue.start, end: cue.end, png: image.pngData()!,
                                      position: CGPoint(x: (size.width - width) / 2, y: size.height * 0.055))
            }
            result.append(raster)
            await Task.yield()
        }
        return result
    }
}

private struct MediaVideoLayer {
    let trackID: CMPersistentTrackID?
    let mediaStart: Double
    let mediaEnd: Double
    let start: Double
    let end: Double
    let opacity: Float
    let fadeIn: Double
    let isBase: Bool
    let order: Int
    let transform: CGAffineTransform
}
private struct MediaRasterCaption {
    let id: UUID
    let start: Double
    let end: Double
    let png: Data
    let position: CGPoint
}
private final class MediaVideoInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = true
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID = kCMPersistentTrackID_Invalid
    let layers: [MediaVideoLayer]
    let captions: [MediaRasterCaption]
    let size: CGSize
    init(timeRange: CMTimeRange, tracks: [CMPersistentTrackID], layers: [MediaVideoLayer], captions: [MediaRasterCaption], size: CGSize) {
        self.timeRange = timeRange; requiredSourceTrackIDs = tracks.map { NSNumber(value: $0) }
        self.layers = layers; self.captions = captions; self.size = size
    }
}

/// Serial CoreImage compositor avoids CoreAnimation export surfaces and renders
/// opaque, letterboxed base frames before dissolving, including audio-only clips.
final class MediaVideoCompositor: NSObject, AVVideoCompositing {
    var sourcePixelBufferAttributes: [String: Any]? { [kCVPixelBufferPixelFormatTypeKey as String: [kCVPixelFormatType_32BGRA]] }
    var requiredPixelBufferAttributesForRenderContext: [String: Any] { [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA] }
    private let queue = DispatchQueue(label: "InkSpace.media-compositor")
    private let context = CIContext(options: [.cacheIntermediates: false, .workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
    private let lock = NSLock()
    private var generation = 0
    private var captionCache: (UUID, CIImage)?
    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}
    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        lock.lock(); let expected = generation; lock.unlock()
        queue.async { [self] in
            if isCancelled(expected) { request.finishCancelledRequest(); return }
            guard let instruction = request.videoCompositionInstruction as? MediaVideoInstruction,
                  let buffer = request.renderContext.newPixelBuffer() else { request.finish(with: MediaEditError.unsupported); return }
            let bounds = CGRect(origin: .zero, size: instruction.size)
            let black = CIImage(color: .black).cropped(to: bounds)
            var frame = black
            let seconds = request.compositionTime.seconds
            for layer in instruction.layers {
                var picture: CIImage?
                if let trackID = layer.trackID, seconds >= layer.mediaStart - 0.000001, seconds < layer.mediaEnd,
                   let source = request.sourceFrame(byTrackID: trackID) {
                    picture = CIImage(cvPixelBuffer: source).transformed(by: layer.transform).cropped(to: bounds)
                }
                if layer.isBase { picture = picture?.composited(over: black) ?? black }
                guard var picture else { continue }
                let opacity = layer.opacity * (layer.fadeIn > 0 ? Float(min(1, max(0, (seconds - layer.start) / layer.fadeIn))) : 1)
                if opacity < 1 { picture = picture.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(opacity))]) }
                frame = picture.composited(over: frame)
            }
            if let cue = instruction.captions.first(where: { seconds >= $0.start && seconds < $0.end }) {
                if captionCache?.0 != cue.id, let image = CIImage(data: cue.png) {
                    captionCache = (cue.id, image.transformed(by: CGAffineTransform(translationX: cue.position.x, y: cue.position.y)))
                }
                if let image = captionCache?.1 { frame = image.composited(over: frame) }
            } else { captionCache = nil }
            context.render(frame, to: buffer, bounds: bounds, colorSpace: nil)
            if isCancelled(expected) { request.finishCancelledRequest() } else { request.finish(withComposedVideoFrame: buffer) }
        }
    }
    func cancelAllPendingVideoCompositionRequests() {
        lock.lock(); generation += 1; lock.unlock()
        queue.sync {}
    }
    private func isCancelled(_ expected: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return generation != expected }
}
