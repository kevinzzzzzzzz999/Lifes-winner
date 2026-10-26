import Foundation
import AVFoundation
import AppKit
import Darwin

func pcmSettings() -> [String: Any] {
    [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000.0, AVNumberOfChannelsKey: 1,
     AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
}
func writeSyntheticWAV(_ url: URL) throws {
    let format = AVAudioFormat(settings: pcmSettings())!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16000)!
    buffer.frameLength = 16000
    for index in 0..<16000 { buffer.int16ChannelData![0][index] = Int16(sin(Double(index) * 0.1) * 1200) }
    let file = try AVAudioFile(forWriting: url, settings: pcmSettings(), commonFormat: .pcmFormatInt16, interleaved: true)
    try file.write(from: buffer)
}
// A dedicated recorder. Merely starting this process never opens the microphone.
final class Recorder: NSObject, AVAudioRecorderDelegate {
    var sessionID: String?
    var destination: URL?
    var audio: AVAudioRecorder?
    var timer: Timer?
    var sequence = 0
    var ending = false
    var signals: [DispatchSourceSignal] = []
    func emit(_ kind: String, _ fields: [String: Any] = [:]) {
        guard let id = sessionID else { return }
        sequence += 1
        var value = fields; value["sessionId"] = id; value["sequence"] = sequence; value["kind"] = kind
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
        }
    }
    func discard(_ code: String? = nil) {
        guard !ending else { return }; ending = true
        timer?.invalidate(); audio?.delegate = nil; audio?.stop(); audio = nil
        if let url = destination { try? FileManager.default.removeItem(at: url) }
        if let code { emit("error", ["code": code]) } else { emit("cancelled") }
        exit(code == nil ? 0 : 1)
    }
    func command(_ data: Data) {
        guard !ending, data.count <= 8192,
              let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let action = request["action"] as? String,
              let id = request["sessionId"] as? String, UUID(uuidString: id) != nil else { return }
        if action == "start" {
            guard sessionID == nil, Set(request.keys) == Set(["action", "sessionId", "output"]),
                  let file = request["output"] as? String, file.hasPrefix("/"), file.hasSuffix(".wav") else { return }
            sessionID = id
            let url = URL(fileURLWithPath: file).standardizedFileURL
            var parentIsDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.deletingLastPathComponent().path, isDirectory: &parentIsDirectory), parentIsDirectory.boolValue,
                  !FileManager.default.fileExists(atPath: url.path) else { discard("recording-failed"); return }
            destination = url; emit("state", ["phase": "permission"])
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: emit("state", ["phase": "ready"])
            case .notDetermined:
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                    DispatchQueue.main.async { guard let self, !self.ending else { return }; if granted { self.ending = true; self.emit("authorized"); exit(0) } else { self.discard("microphone-denied") } }
                }
            default: discard("microphone-denied")
            }
        } else if id == sessionID, Set(request.keys) == Set(["action", "sessionId"]) {
            if action == "record", AVCaptureDevice.authorizationStatus(for: .audio) == .authorized { begin() }
            else if action == "cancel" { discard() }
            else if action == "stop" { finish() }
        }
    }
    func begin() {
        guard !ending, audio == nil, let url = destination else { return }
        do {
            let settings = pcmSettings()
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.delegate = self; audio = recorder
            guard recorder.prepareToRecord(), recorder.record(forDuration: 60) else { discard("audio-unavailable"); return }
            emit("state", ["phase": "recording", "seconds": 0])
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                guard let self, !self.ending, let recorder = self.audio else { return }
                self.emit("state", ["phase": "recording", "seconds": min(60, max(0, recorder.currentTime))])
            }
        } catch { discard("audio-unavailable") }
    }
    func finish() {
        guard !ending else { return }
        guard let recorder = audio else { discard(); return }
        timer?.invalidate(); emit("state", ["phase": "finishing"]); recorder.stop()
    }
    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard !ending else { return }; guard flag else { discard("recording-failed"); return }
        ending = true; timer?.invalidate(); audio = nil
        emit("complete"); exit(0)
    }
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) { discard("recording-failed") }
    func watchExit() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.discard() }; source.resume(); signals.append(source)
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.discard() }
    }
}
// Explicit synthetic file compatibility QA; AVAudioFile writes PCM and never opens a capture device.
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--write-synthetic-wav" {
    let path = CommandLine.arguments[2]
    guard path.hasPrefix("/"), path.hasSuffix(".wav"), !FileManager.default.fileExists(atPath: path) else { exit(2) }
    do {
        try writeSyntheticWAV(URL(fileURLWithPath: path))
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["syntheticOnly": true, "microphoneOpened": false, "sampleRate": 16000, "channels": 1, "bits": 16], options: [.sortedKeys])); exit(0)
    } catch { exit(1) }
}
if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--inspect" {
    let state: String
    switch AVCaptureDevice.authorizationStatus(for: .audio) { case .authorized: state = "granted"; case .notDetermined: state = "not-determined"; default: state = "denied" }
    let value: [String: Any] = ["available": true, "format": "PCM WAV", "sampleRate": 16000, "channels": 1, "bits": 16, "maximumSeconds": 60, "microphonePermission": state, "microphoneOpened": false]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])); exit(0)
}
let recorder = Recorder(); recorder.watchExit()
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        let data = Data(line.utf8)
        DispatchQueue.main.async { recorder.command(data) }
    }
    DispatchQueue.main.async { recorder.discard() }
}
RunLoop.main.run()
