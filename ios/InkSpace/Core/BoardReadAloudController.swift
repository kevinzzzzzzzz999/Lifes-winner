import AVFoundation
import MediaPlayer
import Observation
import OSLog
import UIKit

enum BoardReadAloudLanguage: String, CaseIterable, Identifiable {
    case mixed, mandarin, americanEnglish
    var id: String { rawValue }
    var title: String {
        switch self {
        case .mixed: String(localized: "中英混读")
        case .mandarin: String(localized: "普通话")
        case .americanEnglish: String(localized: "美式英语")
        }
    }
}

@MainActor @Observable
final class BoardReadAloudController: NSObject, AVSpeechSynthesizerDelegate {
    private(set) var isPreparing = false
    private(set) var isSpeaking = false
    private(set) var isPaused = false
    private(set) var currentText = ""
    private(set) var status = ""
    private(set) var rawWordCallbackCount = 0
    private(set) var wordCallbackCount = 0
    private(set) var backgroundWordCallbackCount = 0
    private(set) var startCallbackCount = 0
    private(set) var lastSpeechEvent = "idle"
    var progressAccessibilityValue: String {
        "rawWords=\(rawWordCallbackCount);words=\(wordCallbackCount);backgroundWords=\(backgroundWordCallbackCount);starts=\(startCallbackCount);event=\(lastSpeechEvent)"
    }
    var rate: Float = 0.5
    var languageMode: BoardReadAloudLanguage = .mixed
    private(set) var recognitionVocabularyText: String
    var vocabularyCount: Int { BoardReadAloudText.vocabulary(recognitionVocabularyText).count }
    static func pauseForVideo() { active?.pause() }
    private static weak var active: BoardReadAloudController?
    @ObservationIgnored private var synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var startupWatchdog: Task<Void, Never>?
    @ObservationIgnored private var speakingMessage = ""
    private static let logger = Logger(subsystem: "org.inkspace", category: "ReadAloud65")
    @ObservationIgnored private var recognitionTask: Task<Void, Never>?
    @ObservationIgnored private var requestID = UUID()
    @ObservationIgnored private var sourceKey: BoardTextSelectionSnapshotKey?
    private struct QueuedSpeech {
        let utterance: AVSpeechUtterance
        let line: BoardReadAloudLine
        let run: BoardReadAloudRun
    }
    @ObservationIgnored private var utterances: [QueuedSpeech] = []
    @ObservationIgnored private var remoteTargets: [(MPRemoteCommand, Any)] = []
    @ObservationIgnored private var title = ""
    @ObservationIgnored private var pausedByInterruption = false
    @ObservationIgnored private var ownsAudioSession = false
    @ObservationIgnored var onHighlight: ((BoardTextSelectionSnapshotKey?, CGRect?) -> Void)?
    @ObservationIgnored var onPDFHighlight: ((Int, CGRect?) -> Void)?
    private static let vocabularyKey = "InkSpace.boardReadAloud.confirmedWords.v1"

    override init() {
        recognitionVocabularyText = UserDefaults.standard.string(forKey: Self.vocabularyKey) ?? ""
        super.init()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
        NotificationCenter.default.addObserver(self, selector: #selector(audioInterrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(audioRouteChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
    }

    func saveRecognitionVocabulary(_ text: String) {
        recognitionVocabularyText = BoardReadAloudText.vocabulary(text).joined(separator: "\n")
        UserDefaults.standard.set(recognitionVocabularyText, forKey: Self.vocabularyKey)
        status = String(localized: "常用词已保存在本机，将用于下一次朗读识别。")
    }

    func start(image: UIImage, key: BoardTextSelectionSnapshotKey, title: String) {
        guard let pixels = image.cgImage, key.isValid else { return }
        if Self.active !== self { Self.active?.stop() }
        stop()
        Self.active = self
        let token = UUID(); requestID = token
        sourceKey = key; self.title = title
        isPreparing = true
        status = String(localized: "正在识别当前画面，准备朗读…")
        let words = BoardReadAloudText.vocabulary(recognitionVocabularyText)
        let language = languageMode, speechRate = min(0.7, max(0.2, rate))
        recognitionTask = Task { [weak self] in
            do {
                let lines = try await BoardReadAloudOCR.recognize(pixels, customWords: words)
                try Task.checkCancellation()
                guard let self, self.requestID == token else { return }
                self.recognitionTask = nil; self.isPreparing = false
                guard !lines.isEmpty else {
                    self.status = String(localized: "当前画面未识别到可朗读文字，请放大或检查手写内容。")
                    self.releaseAudioSession()
                    return
                }
                try self.beginSpeaking(lines, language: language, speechRate: speechRate,
                    successMessage: String(localized: "正在朗读当前画面，可切到后台或锁屏继续。"))
            } catch is CancellationError { }
            catch {
                guard let self, self.requestID == token else { return }
                self.isPreparing = false; self.recognitionTask = nil
                self.status = (error as? LocalizedError)?.errorDescription ?? String(localized: "朗读暂不可用，请检查系统语音或稍后重试。")
                self.releaseAudioSession()
            }
        }
    }

    /// Pages are one-based; nil prepares the entire PDF within the stated limits.
    /// Each page's native text is preferred over OCR, so listening can continue
    /// without scrolling or repeatedly capturing the screen.
    func startPDF(url: URL, pages: ClosedRange<Int>? = nil, title: String) {
        if Self.active !== self { Self.active?.stop() }
        stop(); Self.active = self
        let token = UUID(); requestID = token
        self.title = title; isPreparing = true
        status = String(localized: "正在准备 PDF 朗读…")
        let vocabulary = BoardReadAloudText.vocabulary(recognitionVocabularyText)
        let language = languageMode, speechRate = min(0.7, max(0.2, rate))
        recognitionTask = Task { [weak self] in
            do {
                let lines = try await BoardReadAloudPDF.prepare(url: url, pages: pages, customWords: vocabulary) { [weak self] completed, total in
                    Task { @MainActor in
                        guard let self, self.requestID == token, self.isPreparing else { return }
                        self.status = String(localized: "正在准备 PDF 朗读：\(completed)/\(total) 页")
                    }
                }
                try Task.checkCancellation()
                guard let self, self.requestID == token else { return }
                self.recognitionTask = nil; self.isPreparing = false
                guard !lines.isEmpty else {
                    self.status = String(localized: "所选 PDF 页没有可朗读文字；扫描页请检查清晰度。")
                    self.releaseAudioSession(); return
                }
                try self.beginSpeaking(lines, language: language, speechRate: speechRate,
                    successMessage: String(localized: "正在连续朗读 PDF，可切到后台或锁屏继续。"))
            } catch is CancellationError { }
            catch {
                guard let self, self.requestID == token else { return }
                self.isPreparing = false; self.recognitionTask = nil
                self.status = (error as? LocalizedError)?.errorDescription ?? String(localized: "朗读暂不可用，请检查系统语音或稍后重试。")
                self.releaseAudioSession()
            }
        }
    }

    private enum SpeechFailure: Error, LocalizedError {
        case missingVoice(String)
        var errorDescription: String? {
            switch self {
            case .missingVoice(let language):
                language == "zh-CN"
                    ? String(localized: "设备缺少普通话语音，请先在系统设置中下载普通话声音，再重试朗读。")
                    : String(localized: "设备缺少美式英语语音，请先在系统设置中下载美式英语声音，再重试朗读。")
            }
        }
    }

    /// Only voices in the requested locale qualify. A missing voice must not
    /// silently switch to the system's default language.
    private func preferredVoice(for language: String) throws -> AVSpeechSynthesisVoice {
        let preferred = AVSpeechSynthesisVoice(language: language)
        func matches(_ voice: AVSpeechSynthesisVoice) -> Bool {
            voice.language.replacingOccurrences(of: "_", with: "-").lowercased() == language.lowercased()
        }
        var candidates = AVSpeechSynthesisVoice.speechVoices().filter(matches)
        if let preferred, matches(preferred), !candidates.contains(where: { $0.identifier == preferred.identifier }) {
            candidates.append(preferred)
        }
        guard let voice = candidates.sorted(by: {
            if $0.quality.rawValue != $1.quality.rawValue { return $0.quality.rawValue > $1.quality.rawValue }
            if ($0.identifier == preferred?.identifier) != ($1.identifier == preferred?.identifier) {
                return $0.identifier == preferred?.identifier
            }
            return $0.identifier < $1.identifier
        }).first else { throw SpeechFailure.missingVoice(language) }
        return voice
    }

    private func beginSpeaking(_ lines: [BoardReadAloudLine], language: BoardReadAloudLanguage,
                               speechRate: Float, successMessage: String) throws {
        var planned: [(BoardReadAloudLine, BoardReadAloudRun)] = []
        for line in lines {
            let runs: [BoardReadAloudRun]
            switch language {
            case .mixed: runs = BoardReadAloudText.languageRuns(line.text)
            case .mandarin: runs = [BoardReadAloudRun(text: line.text, language: "zh-CN", range: NSRange(location: 0, length: line.text.utf16.count))]
            case .americanEnglish: runs = [BoardReadAloudRun(text: line.text, language: "en-US", range: NSRange(location: 0, length: line.text.utf16.count))]
            }
            planned += runs.map { (line, $0) }
        }
        var voices: [String: AVSpeechSynthesisVoice] = [:]
        for requested in Set(planned.map { $0.1.language }) { voices[requested] = try preferredVoice(for: requested) }
        try beginAudioSession()
        installRemoteCommands()
        synthesizer = AVSpeechSynthesizer()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
        rawWordCallbackCount = 0; wordCallbackCount = 0
        backgroundWordCallbackCount = 0; startCallbackCount = 0
        isPreparing = true
        status = String(localized: "正在启动系统语音…")
        speakingMessage = lines.contains(where: { $0.confidence < 0.6 })
            ? String(localized: "正在朗读；部分手写识别把握较低，请核对黄色标记的原文。") : successMessage
        for (line, run) in planned {
            let utterance = AVSpeechUtterance(string: run.text)
            utterance.voice = voices[run.language]
            utterance.rate = speechRate; utterance.postUtteranceDelay = 0.06
            utterances.append(QueuedSpeech(utterance: utterance, line: line, run: run))
        }
        recordSpeechEvent("queued", matched: !utterances.isEmpty)
        for entry in utterances { synthesizer.speak(entry.utterance) }
        let token = requestID
        startupWatchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, self.requestID == token, self.isPreparing else { return }
            self.recordSpeechEvent("startupTimeout", matched: false)
            self.stop()
            self.status = String(localized: "系统语音未能开始，请检查已下载的声音后重试。")
        }
        updateNowPlaying()
    }

    func pause() {
        guard isSpeaking, !isPaused else { return }
        if synthesizer.pauseSpeaking(at: .immediate) { isPaused = true; updateNowPlaying() }
    }
    func resume() {
        guard isPaused else { return }
        do { try beginAudioSession() }
        catch { status = String(localized: "无法恢复朗读，请稍后重试。"); return }
        if synthesizer.continueSpeaking() { isPaused = false; updateNowPlaying() }
    }
    func stop() {
        let wasActive = isPreparing || isSpeaking || isPaused
        if wasActive { recordSpeechEvent("stop", matched: true) }
        startupWatchdog?.cancel(); startupWatchdog = nil
        requestID = UUID()
        recognitionTask?.cancel(); recognitionTask = nil
        utterances.removeAll()
        synthesizer.stopSpeaking(at: .immediate)
        isPreparing = false; isSpeaking = false; isPaused = false
        currentText = ""; sourceKey = nil
        pausedByInterruption = false
        onHighlight?(nil, nil)
        onPDFHighlight?(-1, nil)
        releaseAudioSession()
        if wasActive { status = String(localized: "已停止朗读") }
    }

    private func beginAudioSession() throws {
        BoardVideoPlayback.stopForReadAloud()
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try audio.setActive(true)
        ownsAudioSession = true
        recordSpeechEvent("audioActivated", matched: true)
    }
    private func releaseAudioSession() {
        for (command, target) in remoteTargets { command.removeTarget(target) }
        remoteTargets.removeAll()
        guard Self.active === self else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        if ownsAudioSession {
            let audio = AVAudioSession.sharedInstance()
            if audio.category == .playback, audio.mode == .spokenAudio {
                try? audio.setActive(false, options: .notifyOthersOnDeactivation)
            }
            ownsAudioSession = false
            recordSpeechEvent("audioReleased", matched: true)
        }
        Self.active = nil
    }
    private func installRemoteCommands() {
        let remote = MPRemoteCommandCenter.shared()
        remote.playCommand.isEnabled = true; remote.pauseCommand.isEnabled = true
        remote.togglePlayPauseCommand.isEnabled = true; remote.stopCommand.isEnabled = true
        func add(_ command: MPRemoteCommand, action: @escaping @MainActor (BoardReadAloudController) -> Void) {
            let target = command.addTarget { [weak self] _ in
                Task { @MainActor in if let self, Self.active === self { action(self) } }
                return .success
            }
            remoteTargets.append((command, target))
        }
        add(remote.playCommand) { $0.resume() }
        add(remote.pauseCommand) { $0.pause() }
        add(remote.togglePlayPauseCommand) { $0.isPaused ? $0.resume() : $0.pause() }
        add(remote.stopCommand) { $0.stop() }
    }
    private func updateNowPlaying() {
        guard Self.active === self else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: currentText.isEmpty ? String(localized: "白板朗读") : currentText,
            MPNowPlayingInfoPropertyPlaybackRate: isSpeaking && !isPaused ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyIsLiveStream: true]
    }

    @objc nonisolated private func audioInterrupted(_ notification: Notification) {
        let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let optionBits = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        Task { @MainActor [weak self] in
            guard let self, Self.active === self, let raw,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            self.recordSpeechEvent(type == .began ? "interruptionBegan" : "interruptionEnded", matched: true)
            if type == .began {
                self.pausedByInterruption = self.isSpeaking && !self.isPaused
                self.pause()
            } else if self.pausedByInterruption {
                self.pausedByInterruption = false
                if AVAudioSession.InterruptionOptions(rawValue: optionBits).contains(.shouldResume) { self.resume() }
            }
        }
    }
    @objc nonisolated private func audioRouteChanged(_ notification: Notification) {
        let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        Task { @MainActor [weak self] in
            guard let self, Self.active === self, let raw,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
            self.recordSpeechEvent("outputRemoved", matched: true)
            self.pause()
        }
    }

    /// AVSpeech may return an utterance copy. Resolve it by queue order and exact
    /// text/locale when identity differs. The synthesizer identity separately
    /// rejects callbacks from stopped/replaced sessions, including equal text.
    private func queueIndex(for utterance: AVSpeechUtterance) -> Int? {
        utterances.firstIndex { $0.utterance === utterance }
            ?? utterances.firstIndex { $0.utterance.speechString == utterance.speechString
                && $0.utterance.voice?.language == utterance.voice?.language }
    }

    private func recordSpeechEvent(_ event: String, matched: Bool) {
        lastSpeechEvent = event
        let audio = AVAudioSession.sharedInstance()
        let background = UIApplication.shared.applicationState != .active
        // Deliberately no transcript, document title, path, or device name.
        Self.logger.notice("event=\(event, privacy: .public) matched=\(matched) background=\(background) queued=\(self.utterances.count) rawWords=\(self.rawWordCallbackCount) words=\(self.wordCallbackCount) backgroundWords=\(self.backgroundWordCallbackCount) category=\(audio.category.rawValue, privacy: .public) mode=\(audio.mode.rawValue, privacy: .public) volume=\(audio.outputVolume)")
    }

    private func confirmedSpeaking() {
        startupWatchdog?.cancel(); startupWatchdog = nil
        isPreparing = false; isSpeaking = true; isPaused = false
        status = speakingMessage
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let sameEngine = synthesizer === self.synthesizer
            let index = sameEngine ? self.queueIndex(for: utterance) : nil
            self.recordSpeechEvent("didStart", matched: index != nil)
            guard index != nil else { return }
            self.startCallbackCount += 1
            self.confirmedSpeaking()
            self.updateNowPlaying()
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Raw progress is recorded before utterance matching for diagnosis.
            if synthesizer === self.synthesizer { self.rawWordCallbackCount += 1 }
            let index = synthesizer === self.synthesizer ? self.queueIndex(for: utterance) : nil
            guard let index else { self.recordSpeechEvent("wordUnmatched", matched: false); return }
            let entry = self.utterances[index], line = entry.line, run = entry.run
            let range = NSRange(location: run.range.location + characterRange.location, length: characterRange.length)
            let bounded = NSIntersectionRange(range, NSRange(location: 0, length: line.text.utf16.count))
            guard bounded.location != NSNotFound, bounded.length > 0 else {
                self.recordSpeechEvent("wordInvalidRange", matched: true); return
            }
            self.confirmedSpeaking()
            self.wordCallbackCount += 1
            if UIApplication.shared.applicationState != .active { self.backgroundWordCallbackCount += 1 }
            self.currentText = (line.text as NSString).substring(with: bounded)
            if let page = line.pageIndex { self.onPDFHighlight?(page, line.highlight(for: range)) }
            else if let key = self.sourceKey { self.onHighlight?(key, line.highlight(for: range)) }
            self.recordSpeechEvent("word", matched: true)
            self.updateNowPlaying()
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let index = synthesizer === self.synthesizer ? self.queueIndex(for: utterance) : nil
            self.recordSpeechEvent("didFinish", matched: index != nil)
            guard let index else { return }
            self.utterances.remove(at: index)
            if self.utterances.isEmpty {
                self.isPreparing = false; self.isSpeaking = false; self.isPaused = false
                self.startupWatchdog?.cancel(); self.startupWatchdog = nil
                self.onHighlight?(nil, nil)
                self.onPDFHighlight?(-1, nil)
                self.status = String(localized: "朗读完毕")
                self.releaseAudioSession()
            }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didPause utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let matches = synthesizer === self.synthesizer && self.queueIndex(for: utterance) != nil
            self.recordSpeechEvent("didPause", matched: matches)
            guard matches else { return }
            self.isPaused = true; self.updateNowPlaying()
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didContinue utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let matches = synthesizer === self.synthesizer && self.queueIndex(for: utterance) != nil
            self.recordSpeechEvent("didContinue", matched: matches)
            guard matches else { return }
            self.confirmedSpeaking(); self.updateNowPlaying()
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            let index = synthesizer === self.synthesizer ? self.queueIndex(for: utterance) : nil
            self.recordSpeechEvent("didCancel", matched: index != nil)
            guard let index else { return }
            self.utterances.remove(at: index)
            if self.utterances.isEmpty {
                self.isPreparing = false; self.isSpeaking = false; self.isPaused = false
                self.startupWatchdog?.cancel(); self.startupWatchdog = nil
                self.onHighlight?(nil, nil); self.onPDFHighlight?(-1, nil)
                self.status = String(localized: "朗读已中断，可重新开始。")
                self.releaseAudioSession()
            }
        }
    }
}
