import AVFoundation
import CoreVideo
import CryptoKit
import Foundation

/// All output is non-destructive. Sources are coordinated snapshots and the final
/// file is published only after the export completed and its tracks were reopened.
@MainActor final class MediaExportService {
    private var session: AVAssetExportSession?
    private var cancelled = false
    private var exporting = false
    private var cancellation = MediaExportCancellation()
    func cancel() { cancelled = cancellation.cancel(); if cancelled { session?.cancelExport() } }

    static func probe(url: URL, relativePath: String) async throws -> MediaSource {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        let video = try await asset.loadTracks(withMediaType: .video)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        guard duration.isFinite, duration > 0, duration <= 43_200, !video.isEmpty || !audio.isEmpty else { throw MediaEditError.unsupported }
        let digest = try await Task.detached(priority: .utility) { try hashFile(url) }.value
        return MediaSource(path: relativePath, name: url.lastPathComponent, duration: duration,
                           hasVideo: !video.isEmpty, hasAudio: !audio.isEmpty, sha256: digest)
    }

    func preview(project: MediaProject, root: URL, progress: @escaping @MainActor (Double) -> Void) async throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("MediaPreview-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var value = project; value.output.width = 1280; value.output.height = 720
        let output = folder.appendingPathComponent("preview." + (value.output.kind == "video" ? "mp4" : "m4a"))
        do { return try await render(project: value, root: root, to: output, temporaryPreview: true, progress: progress) }
        catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
    static func discardPreview(_ url: URL) {
        let folder = url.deletingLastPathComponent().standardizedFileURL
        let root = FileManager.default.temporaryDirectory.standardizedFileURL
        if folder.deletingLastPathComponent() == root, folder.lastPathComponent.hasPrefix("MediaPreview-") {
            try? FileManager.default.removeItem(at: folder)
        }
    }
    func export(project: MediaProject, root: URL, to output: URL,
                progress: @escaping @MainActor (Double) -> Void) async throws -> URL {
        try await render(project: project, root: root, to: output, temporaryPreview: false, progress: progress)
    }
    private func render(project: MediaProject, root: URL, to output: URL, temporaryPreview: Bool,
                progress: @escaping @MainActor (Double) -> Void) async throws -> URL {
        guard !exporting else { throw MediaEditError.exportFailed("An export is already running.") }
        try project.validate(); guard !project.clips.isEmpty else { throw MediaEditError.unsupported }
        let rootPath = root.standardizedFileURL.resolvingSymlinksInPath().path
        let destinationParent = output.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
        guard temporaryPreview || destinationParent.path == rootPath || destinationParent.path.hasPrefix(rootPath + "/"),
              output.pathExtension.lowercased() == (project.output.kind == "video" ? "mp4" : "m4a") else { throw MediaEditError.invalidProject }
        guard !FileManager.default.fileExists(atPath: output.path) else { throw MediaEditError.existingFile }
        exporting = true; cancelled = false; cancellation = MediaExportCancellation()
        let access = root.startAccessingSecurityScopedResource()
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("MediaExport-" + UUID().uuidString)
        defer {
            session = nil; exporting = false
            if access { root.stopAccessingSecurityScopedResource() }
            try? FileManager.default.removeItem(at: scratch)
        }
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        progress(0)
        let used = Set(project.clips.map(\.sourceID) + project.overlays.map(\.sourceID))
        var assets: [UUID: AVURLAsset] = [:]
        let sources = project.sources.filter { used.contains($0.id) }
        for (index, source) in sources.enumerated() {
            try checkCancellation()
            guard let original = VaultPathResolver.resolve(relativePath: source.path, within: root) else { throw MediaEditError.sourceChanged(source.name) }
            let snapshot = scratch.appendingPathComponent(source.id.uuidString + "." + original.pathExtension)
            try await Task.detached(priority: .userInitiated) {
                var coordination: NSError?, failure: Error?
                NSFileCoordinator().coordinate(readingItemAt: original, options: [], error: &coordination) { readable in
                    do { try FileManager.default.copyItem(at: readable, to: snapshot) } catch { failure = error }
                }
                if let coordination { throw coordination }; if let failure { throw failure }
                if let expected = source.sha256, try hashFile(snapshot).lowercased() != expected.lowercased() { throw MediaEditError.sourceChanged(source.name) }
            }.value
            let asset = AVURLAsset(url: snapshot)
            let currentDuration = try await asset.load(.duration).seconds
            guard currentDuration.isFinite, abs(currentDuration - source.duration) < 0.1 else { throw MediaEditError.sourceChanged(source.name) }
            assets[source.id] = asset
            progress(Double(index + 1) / Double(sources.count) * 0.1)
        }
        let silenceURL = scratch.appendingPathComponent("silence.wav")
        try Self.writeSilence(to: silenceURL)
        let silence = AVURLAsset(url: silenceURL)
        guard let silenceTrack = try await silence.loadTracks(withMediaType: .audio).first else { throw MediaEditError.unsupported }
        var blackTrack: AVAssetTrack?
        var blackAsset: AVURLAsset?
        defer { withExtendedLifetime(blackAsset) {} }
        if project.output.kind == "video" {
            let blackURL = scratch.appendingPathComponent("black.mp4")
            do { try await writeBlackVideo(to: blackURL) }
            catch MediaEditError.cancelled { throw MediaEditError.cancelled }
            catch { throw MediaEditError.exportFailed("Black frame preparation: " + error.localizedDescription) }
            blackAsset = AVURLAsset(url: blackURL)
            blackTrack = try await blackAsset?.loadTracks(withMediaType: .video).first
        }
        let rendered: MediaCompositionRenderer.Result
        do { rendered = try await MediaCompositionRenderer.build(project: project, assets: assets, silence: silenceTrack,
                                                                 black: blackTrack, checkCancellation: checkCancellation) }
        catch MediaEditError.cancelled { throw MediaEditError.cancelled }
        catch { throw MediaEditError.exportFailed("Composition preparation: " + error.localizedDescription) }
        progress(0.2)
        let preset = project.output.kind == "video" ? AVAssetExportPresetHighestQuality : AVAssetExportPresetAppleM4A
        guard let exporter = AVAssetExportSession(asset: rendered.composition, presetName: preset) else { throw MediaEditError.unsupported }
        session = exporter
        exporter.outputFileType = project.output.kind == "video" ? .mp4 : .m4a
        let temporaryOutput = scratch.appendingPathComponent("result." + (project.output.kind == "video" ? "mp4" : "m4a"))
        exporter.outputURL = temporaryOutput
        exporter.shouldOptimizeForNetworkUse = true
        exporter.audioTimePitchAlgorithm = .spectral
        exporter.audioMix = rendered.audioMix
        exporter.videoComposition = rendered.videoComposition
        try checkCancellation()
        let reporter = Task { @MainActor in
            while !Task.isCancelled {
                progress(0.2 + Double(exporter.progress) * 0.75)
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                exporter.exportAsynchronously { continuation.resume() }
            }
        } onCancel: { exporter.cancelExport() }
        reporter.cancel()
        if exporter.status == .cancelled || cancelled || Task.isCancelled { throw MediaEditError.cancelled }
        guard exporter.status == .completed else { throw MediaEditError.exportFailed(exporter.error?.localizedDescription ?? "Unknown export error") }
        let check = AVURLAsset(url: temporaryOutput)
        let exportedDuration = try await check.load(.duration).seconds
        guard exportedDuration.isFinite, abs(exportedDuration - project.duration) < max(0.3, project.duration * 0.001),
              (try await check.loadTracks(withMediaType: project.output.kind == "video" ? .video : .audio)).isEmpty == false
        else { throw MediaEditError.exportFailed("Export verification failed") }
        progress(0.96)
        try checkCancellation()
        let cancellation = self.cancellation
        try await Task.detached(priority: .userInitiated) {
            let temporaryDestination = destinationParent.appendingPathComponent(".inkspace-export-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: temporaryDestination) }
            guard FileManager.default.createFile(atPath: temporaryDestination.path, contents: nil) else { throw MediaEditError.exportFailed("Cannot create output") }
            let input = try FileHandle(forReadingFrom: temporaryOutput)
            let destination = try FileHandle(forWritingTo: temporaryDestination)
            defer { try? input.close(); try? destination.close() }
            while let bytes = try input.read(upToCount: 1024 * 1024), !bytes.isEmpty {
                try cancellation.check(); try destination.write(contentsOf: bytes)
            }
            try destination.synchronize(); try cancellation.check()
            var error: NSError?, failure: Error?
            NSFileCoordinator().coordinate(writingItemAt: output, options: [], error: &error) { coordinated in
                do {
                    try cancellation.commit {
                        guard !FileManager.default.fileExists(atPath: coordinated.path) else { throw MediaEditError.existingFile }
                        try FileManager.default.moveItem(at: temporaryDestination, to: coordinated)
                    }
                } catch { failure = error }
            }
            if let error { throw error }; if let failure { throw failure }
        }.value
        progress(1); return output
    }

    private func checkCancellation() throws { if cancelled || Task.isCancelled { throw MediaEditError.cancelled } }
    private func insertSilence(_ source: AVAssetTrack, into target: AVMutableCompositionTrack, at point: CMTime, duration: CMTime) throws {
        var left = duration, cursor = point
        while left.seconds > 0.00001 {
            try checkCancellation()
            let piece = CMTimeMinimum(left, CMTime(seconds: 60, preferredTimescale: 16000))
            try target.insertTimeRange(CMTimeRange(start: .zero, duration: piece), of: source, at: cursor)
            cursor = CMTimeAdd(cursor, piece); left = CMTimeSubtract(left, piece)
        }
    }
    private static func writeSilence(to url: URL) throws {
        let length: UInt32 = 60 * 16000 * 2
        var data = Data()
        func text(_ value: String) { data.append(Data(value.utf8)) }
        func u32(_ value: UInt32) { var value = value.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { var value = value.littleEndian; withUnsafeBytes(of: &value) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(length + 36); text("WAVEfmt "); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16); text("data"); u32(length)
        data.append(Data(count: Int(length))); try data.write(to: url, options: .atomic)
    }
    private func writeBlackVideo(to url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64])
        let attributes: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64]
        let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
        guard writer.canAdd(input) else { throw MediaEditError.unsupported }
        writer.add(input); guard writer.startWriting() else { throw MediaEditError.exportFailed(writer.error?.localizedDescription ?? "Video writer") }
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess, let buffer else { throw MediaEditError.unsupported }
        CVPixelBufferLockBaseAddress(buffer, [])
        if let memory = CVPixelBufferGetBaseAddress(buffer) { memset(memory, 0, CVPixelBufferGetDataSize(buffer)) }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        do {
            for index in 0..<30 {
                try checkCancellation()
                while !input.isReadyForMoreMediaData {
                    guard writer.status == .writing else { throw MediaEditError.exportFailed(writer.error?.localizedDescription ?? "Video writer") }
                    try await Task.sleep(for: .milliseconds(5)); try checkCancellation()
                }
                guard adapter.append(buffer, withPresentationTime: CMTime(value: Int64(index), timescale: 30)) else { throw MediaEditError.unsupported }
            }
            input.markAsFinished(); writer.endSession(atSourceTime: CMTime(value: 1, timescale: 1))
            await writer.finishWriting()
            guard writer.status == .completed else { throw MediaEditError.exportFailed(writer.error?.localizedDescription ?? "Video writer") }
        } catch { writer.cancelWriting(); throw error }
    }
}

private func hashFile(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
    var hash = SHA256()
    while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data); try Task.checkCancellation() }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

/// Cancellation stays observable while copying a large result. Publishing is the
/// commit boundary: a cancellation after the atomic rename is already too late.
private final class MediaExportCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var committed = false
    @discardableResult func cancel() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if committed { return false }
        cancelled = true; return true
    }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled || Task.isCancelled { throw MediaEditError.cancelled }
    }
    func commit(_ body: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled || Task.isCancelled { throw MediaEditError.cancelled }
        try body(); committed = true
    }
}
