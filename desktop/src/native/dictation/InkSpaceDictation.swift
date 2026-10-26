import Foundation
import AppKit
import AVFoundation
import Speech
import CoreMedia

private enum SpeechFailure: String, Error {
    case microphoneDenied = "microphone-denied", unavailable = "unavailable", languageUnavailable = "language-unavailable", modelUnavailable = "model-unavailable", audioUnavailable = "audio-unavailable", recognitionFailed = "recognition-failed", permissionDenied = "speech-permission-denied", invalidRequest = "invalid-request", textLimit = "text-limit", audioNotReady = "audio-not-ready", rangeUnavailable = "transcription-range-unavailable", permissionRequired = "microphone-permission-required"
}
private func emit(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}

@available(macOS 26.0, *)
private func timedText(_ text: AttributedString, range: CMTimeRange) -> [DictationTranscript.TimedText] {
    var pieces: [DictationTranscript.TimedText] = [], leading=""
    for run in text.runs {
        let value=String(text[run.range].characters)
        if let time=run.audioTimeRange {
            pieces.append(.init(start:time.start.seconds,end:CMTimeRangeGetEnd(time).seconds,text:leading+value));leading=""
        } else if let last=pieces.popLast() {
            pieces.append(.init(start:last.start,end:last.end,text:last.text+value))
        } else { leading += value }
    }
    if pieces.isEmpty, !leading.isEmpty { return [] }
    return pieces
}

@MainActor
private final class DictationRun {
    let id: String
    let locale: Locale
    let hints: [String]
    var generation = UUID()
    var cancelled = false
    var finishing = false
    var engine: AVAudioEngine?
    var tapInstalled = false
    var captureReadiness: DictationAudioReadiness?
    var audioWatchdog: Task<Void, Never>?
    var analyzer: AnyObject?
    var continuation: AsyncStream<AnalyzerInput>.Continuation?
    var resultTask: Task<Void, Never>?
    var startTask: Task<Void, Never>?
    var legacyRecognizer: SFSpeechRecognizer?
    var legacyTask: SFSpeechRecognitionTask?
    var legacyRequest: SFSpeechAudioBufferRecognitionRequest?
    var transcript = DictationTranscript()
    var latestText = ""
    var rangePending=false
    var rangeNeedsReview=false
    var backend = "dictation"
    var sequence = 0
    var completed = false
    init(id: String, locale: Locale, hints: [String]) { self.id = id; self.locale = locale; self.hints = hints }
    func send(_ kind: String, _ extra: [String: Any] = [:]) {
        guard !completed else { return }
        sequence += 1
        var value: [String: Any] = ["sessionId": id, "sequence": sequence, "kind": kind, "engine": backend]
        extra.forEach { value[$0.key] = $0.value }; emit(value)
    }
    func begin(probeOnly:Bool=false) {
        send("state", ["phase": "preparing", "stage":"permission-check"])
        let missingID=id,missingSequence=sequence+1
        startTask = Task { [weak self] in
            guard let self else { emit(["sessionId":missingID,"sequence":missingSequence,"kind":"state","engine":"dictation","phase":"preparing","stage":"start-task-released"]);emit(["sessionId":missingID,"sequence":missingSequence+1,"kind":"error","engine":"dictation","code":"unavailable","text":""]);return }
            send("state",["phase":"preparing","stage":"start-task-entered"])
            do {
                try check()
                send("state",["phase":"preparing","stage":"authorization-status-begin"])
                let status=AVCaptureDevice.authorizationStatus(for:.audio)
                let statusStage:String
                switch status {case .authorized:statusStage="authorization-authorized";case .notDetermined:statusStage="authorization-not-determined";case .denied:statusStage="authorization-denied";case .restricted:statusStage="authorization-restricted";@unknown default:statusStage="authorization-unknown"}
                send("state",["phase":"preparing","stage":statusStage])
                // Fixed diagnostic command: exercise the exact nested task/status
                // path, then finish without requesting access or opening capture.
                if probeOnly {send("complete",["text":""]);completed=true;return}
                let granted: Bool
                switch status {
                case .authorized: granted = true
                case .notDetermined: throw SpeechFailure.permissionRequired
                default: granted = false
                }
                guard granted else { throw SpeechFailure.microphoneDenied }
                send("state",["phase":"preparing","stage":"permission-granted"])
                try check()
                if #available(macOS 26.0, *) {
                    do { try await beginDictation(); return }
                    catch is CancellationError { throw CancellationError() }
                    catch { try check(); await resetModern() }
                    if SpeechTranscriber.isAvailable {
                        do { try await beginAnalyzer(); return }
                        catch is CancellationError { throw CancellationError() }
                        catch { try check(); await resetModern() }
                    }
                    send("state", ["phase":"preparing", "notice":"fallback-local"])
                }
                try await beginLegacy()
            } catch is CancellationError { await cancel() }
            catch { fail(error) }
        }
    }
    func check() throws { if cancelled || completed || Task.isCancelled { throw CancellationError() } }
    func update(_ text: String) {
        guard !cancelled && !completed else { return }
        guard text.utf16.count <= 20000 else { fail(SpeechFailure.textLimit); return }
        latestText = text; send("result", ["text": text])
    }
    @available(macOS 26.0, *)
    func receiveResult(range: CMTimeRange,text:AttributedString,final:Bool,finalized:CMTime) {
        let accepted=transcript.receive(start:range.start.seconds,end:CMTimeRangeGetEnd(range).seconds,text:String(text.characters),final:final,finalizationTime:finalized.seconds,pieces:timedText(text,range:range))
        if !accepted {
            let changed = !rangePending || (final && !rangeNeedsReview)
            rangePending=true;rangeNeedsReview = rangeNeedsReview || final
            if changed {send("state",["phase":finishing ? "finishing":"listening","audioReady":true,"notice":rangeNeedsReview ? "range-review":"range-pending","stage":rangeNeedsReview ? "range-review":"range-pending"])}
            return
        }
        if rangePending && !rangeNeedsReview {send("state",["phase":finishing ? "finishing":"listening","audioReady":true,"notice":"range-recovered","stage":"range-recovered"])}
        rangePending=false;update(transcript.text)
    }
    @available(macOS 26.0, *)
    func resetModern() async {
        stopAudio();continuation?.finish();continuation=nil;resultTask?.cancel();resultTask=nil
        if let active=analyzer as? SpeechAnalyzer {await active.cancelAndFinishNow()};analyzer=nil
    }
    @available(macOS 26.0, *)
    func beginDictation() async throws {
        send("state",["phase":"preparing","stage":"dictation-locale"])
        guard let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) else { throw SpeechFailure.languageUnavailable }
        try check()
        var preset = DictationTranscriber.Preset.progressiveShortDictation
        preset.transcriptionOptions.insert(.punctuation)
        preset.attributeOptions.insert(.audioTimeRange)
        let transcriber = DictationTranscriber(locale:supported,preset:preset)
        send("state",["phase":"preparing","stage":"dictation-assets"])
        guard await AssetInventory.status(forModules:[transcriber]) == .installed else { throw SpeechFailure.modelUnavailable }
        try check()
        send("state",["phase":"preparing","stage":"dictation-format"])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw SpeechFailure.modelUnavailable }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        send("state",["phase":"preparing","stage":"dictation-context"])
        let context = AnalysisContext(); context.contextualStrings[.general] = hints; try await analyzer.setContext(context)
        send("state",["phase":"preparing","stage":"dictation-prepare"])
        try await analyzer.prepareToAnalyze(in: format)
        try check()
        let pair = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(128))
        continuation = pair.continuation
        resultTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self, !self.cancelled, !self.completed else { break }
                    self.receiveResult(range:result.range,text:result.text,final:result.isFinal,finalized:result.resultsFinalizationTime)
                }
            } catch { if let self, !self.cancelled, !self.finishing { self.fail(SpeechFailure.recognitionFailed) } }
        }
        do {
            send("state",["phase":"preparing","stage":"dictation-stream-start"])
            try await analyzer.start(inputSequence: pair.stream)
            try check()
            backend = "dictation"
            try startAudio(format: format) { [weak self] buffer in
                switch pair.continuation.yield(AnalyzerInput(buffer: buffer)) { case .enqueued: return true; case .dropped: Task { @MainActor in self?.fail(SpeechFailure.audioUnavailable) };return false; case .terminated: return false; @unknown default: return false }
            }
            
        } catch { await analyzer.cancelAndFinishNow(); resultTask?.cancel(); resultTask = nil; continuation?.finish(); continuation = nil; self.analyzer = nil; throw error }
    }
    @available(macOS 26.0, *)
    func beginAnalyzer() async throws {
        send("state",["phase":"preparing","stage":"analyzer-locale"])
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { throw SpeechFailure.languageUnavailable }
        try check()
        var preset=SpeechTranscriber.Preset.progressiveTranscription;preset.attributeOptions.insert(.audioTimeRange)
        let transcriber = SpeechTranscriber(locale: supported, preset: preset)
        send("state",["phase":"preparing","stage":"analyzer-assets"])
        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            send("state", ["phase": "downloading"])
            try await installation.downloadAndInstall()
        }
        try check()
        send("state",["phase":"preparing","stage":"analyzer-format"])
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw SpeechFailure.modelUnavailable }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        self.analyzer = analyzer
        send("state",["phase":"preparing","stage":"analyzer-context"])
        let context = AnalysisContext(); context.contextualStrings[.general] = hints; try await analyzer.setContext(context)
        send("state",["phase":"preparing","stage":"analyzer-prepare"])
        try await analyzer.prepareToAnalyze(in: format)
        try check()
        let pair = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(128))
        continuation = pair.continuation
        resultTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self, !self.cancelled, !self.completed else { break }
                    self.receiveResult(range:result.range,text:result.text,final:result.isFinal,finalized:result.resultsFinalizationTime)
                }
            } catch { if let self, !self.cancelled, !self.finishing { self.fail(SpeechFailure.recognitionFailed) } }
        }
        do {
            send("state",["phase":"preparing","stage":"analyzer-stream-start"])
            try await analyzer.start(inputSequence: pair.stream)
            try check()
            backend = "analyzer"
            try startAudio(format: format) { [weak self] buffer in
                switch pair.continuation.yield(AnalyzerInput(buffer: buffer)) { case .enqueued: return true; case .dropped: Task { @MainActor in self?.fail(SpeechFailure.audioUnavailable) };return false; case .terminated: return false; @unknown default: return false }
            }
            
        } catch { await analyzer.cancelAndFinishNow(); resultTask?.cancel(); resultTask = nil; continuation?.finish(); continuation = nil; self.analyzer = nil; throw error }
    }
    func beginLegacy() async throws {
        backend = "local-system"
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else { throw SpeechFailure.modelUnavailable }
        let authorization = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        try check(); guard authorization == .authorized else { throw SpeechFailure.permissionDenied }
        guard recognizer.isAvailable else { throw SpeechFailure.unavailable }
        let request = SFSpeechAudioBufferRecognitionRequest(); request.shouldReportPartialResults = true; request.requiresOnDeviceRecognition = true; request.taskHint = .dictation; request.contextualStrings = hints
        if #available(macOS 13.0, *) { request.addsPunctuation = true }
        legacyRecognizer = recognizer; legacyRequest = request
        legacyTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self, !self.cancelled, !self.completed else { return }
                if let result { self.update(result.bestTranscription.formattedString); if result.isFinal { self.finishOutput() } }
                if error != nil { if self.finishing { self.finishOutput() } else { self.fail(SpeechFailure.recognitionFailed) } }
            }
        }
        try startAudio(format: nil) { buffer in request.append(buffer); return true }
    }
    func startAudio(format desired: AVAudioFormat?, receive: @escaping (AVAudioPCMBuffer) -> Bool) throws {
        send("state",["phase":"preparing","stage":"audio-input"])
        let engine = AVAudioEngine(), input = engine.inputNode, format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw SpeechFailure.audioUnavailable }
        let target = desired ?? format
        guard let converter = AVAudioConverter(from: format, to: target) else { throw SpeechFailure.audioUnavailable }
        converter.primeMethod = .none
        let readiness=DictationAudioReadiness(startedAt:ProcessInfo.processInfo.systemUptime);captureReadiness=readiness
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            // Convert/copy before returning from the tap: the input buffer may be reused.
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * target.sampleRate / format.sampleRate)) + 32
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var consumed = false, error: NSError?
            let status = converter.convert(to: output, error: &error) { _, state in
                if consumed { state.pointee = .noDataNow; return nil }
                consumed = true; state.pointee = .haveData; return buffer
            }
            if status != .error, error == nil, output.frameLength > 0, receive(output) {
                let first=readiness.receivedFrame(at:ProcessInfo.processInfo.systemUptime)
                if first { Task { @MainActor in guard let self,self.captureReadiness === readiness,!self.cancelled,!self.completed,!self.finishing else{return};self.send("state",["phase":"listening","audioReady":true,"stage":"audio-ready"]) } }
            }
            else if error != nil { Task { @MainActor in self?.fail(SpeechFailure.audioUnavailable) } }
        }
        tapInstalled = true; self.engine = engine;send("state",["phase":"preparing","stage":"audio-start"]);engine.prepare();try engine.start()
        send("state",["phase":"arming","stage":"audio-arming"])
        audioWatchdog=Task { [weak self] in
            while !Task.isCancelled {
                do {try await Task.sleep(for:.milliseconds(250))} catch {return}
                guard let self,self.captureReadiness === readiness,!self.cancelled,!self.completed,!self.finishing else{return}
                if readiness.timedOut(at:ProcessInfo.processInfo.systemUptime) {self.fail(SpeechFailure.audioNotReady);return}
            }
        }
    }
    func stopAudio() { captureReadiness?.invalidate();captureReadiness=nil;audioWatchdog?.cancel();audioWatchdog=nil;engine?.stop(); if tapInstalled { engine?.inputNode.removeTap(onBus: 0); tapInstalled = false }; engine = nil }
    func stop() async {
        guard !completed, !cancelled, !finishing else { return }
        finishing = true; send("state", ["phase":"finishing"]); stopAudio()
        if #available(macOS 26.0, *), let analyzer = analyzer as? SpeechAnalyzer {
            continuation?.finish(); continuation = nil
            do { try await analyzer.finalizeAndFinishThroughEndOfInput(); await resultTask?.value; finishOutput() }
            catch { if !cancelled { finishOutput() } }
        } else if legacyRequest != nil { legacyRequest?.endAudio(); legacyTask?.finish() }
        else { await cancel() }
    }
    func finishOutput() {
        guard !completed, !cancelled else { return }
        stopAudio(); send("complete", ["text":latestText,"notice":(rangePending || rangeNeedsReview) ? "range-review":"range-recovered"]); completed = true
        legacyTask?.cancel(); legacyTask = nil; legacyRequest = nil; legacyRecognizer = nil
    }
    func fail(_ error: Error) {
        guard !completed, !cancelled else { return }
        stopAudio(); send("error", ["code": (error as? SpeechFailure)?.rawValue ?? SpeechFailure.recognitionFailed.rawValue, "text":latestText]); completed = true
        continuation?.finish(); resultTask?.cancel(); legacyTask?.cancel(); legacyRequest?.endAudio()
        if #available(macOS 26.0, *), let analyzer = analyzer as? SpeechAnalyzer { Task { await analyzer.cancelAndFinishNow() } }
    }
    func cancel() async {
        guard !cancelled else { return }
        cancelled = true; startTask?.cancel(); stopAudio(); continuation?.finish(); continuation = nil; resultTask?.cancel(); legacyTask?.cancel(); legacyRequest?.endAudio()
        if #available(macOS 26.0, *), let analyzer = analyzer as? SpeechAnalyzer { await analyzer.cancelAndFinishNow() }
        if !completed { sequence += 1; emit(["sessionId":id,"sequence":sequence,"kind":"cancelled","engine":backend]); completed = true }
    }
}

@MainActor
private final class Controller {
    var run: DictationRun?
    var modelRequest: AnyObject?
    var modelTimeout: DispatchSourceTimer?
    var modelSignal: DispatchSourceSignal?
    var modelObservation: NSKeyValueObservation?
    func command(_ data: Data) async {
        guard data.count <= 65536, let value = try? JSONSerialization.jsonObject(with: data) as? [String:Any], let action = value["action"] as? String else { return }
        if action == "info" { await info(); return }
        guard let id = value["sessionId"] as? String, UUID(uuidString:id) != nil else { return }
        if action == "start" || action == "probe-start" {
            guard let locale = value["locale"] as? String, ["zh-CN","en-US"].contains(locale), let hints = value["contextWords"] as? [String], hints.count <= 100, hints.allSatisfy({ $0.utf16.count <= 80 && !$0.contains("\0") }) else {
                emit(["sessionId":id,"sequence":1,"kind":"error","engine":"dictation","code":"invalid-request","text":""]);return
            }
            let next=DictationRun(id:id,locale:Locale(identifier:locale),hints:hints)
            next.send("state",["phase":"preparing","stage":"command-accepted"])
            let previous=run;run=next;await previous?.cancel();next.begin(probeOnly:action=="probe-start")
        } else if run?.id == id { if action == "stop" { await run?.stop() } else if action == "cancel" { await run?.cancel() } }
    }
    @available(macOS 26.0, *)
    func prepareModel(locale: String, timeout: Int) async {
        do {
            guard ["zh-CN","en-US"].contains(locale), SpeechTranscriber.isAvailable, let supported = await SpeechTranscriber.supportedLocale(equivalentTo:Locale(identifier:locale)) else { throw SpeechFailure.languageUnavailable }
            let transcriber = SpeechTranscriber(locale:supported,preset:.transcription)
            guard let request = try await AssetInventory.assetInstallationRequest(supporting:[transcriber]) else { emit(["kind":"model-ready","locale":locale,"status":"installed","recordingSaved":false]); exit(0) }
            modelRequest = request
            modelObservation = request.progress.observe(\.fractionCompleted, options:[.initial,.new]) { progress, _ in
                emit(["kind":"model-progress","locale":locale,"fraction":progress.fractionCompleted,"completedUnits":progress.completedUnitCount,"totalUnits":progress.totalUnitCount,"recordingSaved":false])
            }
            let timer = DispatchSource.makeTimerSource(queue:.main);timer.schedule(deadline:.now()+Double(timeout));timer.setEventHandler { [weak self] in self?.cancelModel("timeout") };modelTimeout=timer;timer.resume()
            signal(SIGTERM,SIG_IGN);let cancelSignal=DispatchSource.makeSignalSource(signal:SIGTERM,queue:.main);cancelSignal.setEventHandler { [weak self] in self?.cancelModel("cancelled") };modelSignal=cancelSignal;cancelSignal.resume()
            try await request.downloadAndInstall()
            modelTimeout?.cancel();modelSignal?.cancel();modelObservation=nil
            emit(["kind":"model-ready","locale":locale,"status":"installed","recordingSaved":false]);exit(0)
        } catch { emit(["kind":"model-error","code":(error as? SpeechFailure)?.rawValue ?? "model-unavailable","recordingSaved":false]);exit(2) }
    }
    func cancelModel(_ reason: String) {
        if #available(macOS 26.0, *), let request = modelRequest as? AssetInstallationRequest { request.progress.cancel() }
        emit(["kind":"model-error","code":reason,"cancelRequested":true,"recordingSaved":false]);exit(3)
    }
    @available(macOS 26.0, *)
    func recognizeFile(_ file: String, locale: String, engineName: String, hints: [String], progressive:Bool=false) async {
        var transcript = DictationTranscript(), rawSegments: [[String:Any]] = [];var deferredVolatile=0,unmergedFinals=0
        do {
            guard ["zh-CN","en-US"].contains(locale), ["analyzer","dictation"].contains(engineName) else { throw SpeechFailure.languageUnavailable }
            let add: (CMTimeRange, AttributedString, Bool, CMTime) throws -> Void = { range, attributed, final, finalized in
                let text=String(attributed.characters),parts=timedText(attributed,range:range)
                let start=range.start.seconds,end=CMTimeRangeGetEnd(range).seconds
                let accepted=transcript.receive(start:start,end:end,text:text,final:final,finalizationTime:finalized.seconds,pieces:parts)
                rawSegments.append(["start":start,"end":end,"text":text,"isFinal":final,"finalizationTime":finalized.seconds,"parts":parts.map{["start":$0.start,"end":$0.end,"text":$0.text] as [String:Any]},"mergeAccepted":accepted,"mergeReason":transcript.rejectionReason ?? "accepted"])
                if !accepted {if final {unmergedFinals+=1}else{deferredVolatile+=1}}
            }
            let module: any SpeechModule
            let result: Task<String, Error>
            if engineName == "dictation" {
                guard let supported=await DictationTranscriber.supportedLocale(equivalentTo:Locale(identifier:locale)) else { throw SpeechFailure.languageUnavailable }
                var preset=progressive ? DictationTranscriber.Preset.progressiveShortDictation : .shortDictation;preset.transcriptionOptions.insert(.punctuation);preset.attributeOptions.insert(.audioTimeRange)
                let transcriber=DictationTranscriber(locale:supported,preset:preset)
                guard await AssetInventory.status(forModules:[transcriber]) == .installed else { throw SpeechFailure.modelUnavailable }
                module=transcriber
                result=Task { @MainActor in
                    for try await segment in transcriber.results {try add(segment.range,segment.text,segment.isFinal,segment.resultsFinalizationTime)}
                    return transcript.text
                }
            } else {
                guard SpeechTranscriber.isAvailable, let supported=await SpeechTranscriber.supportedLocale(equivalentTo:Locale(identifier:locale)) else { throw SpeechFailure.languageUnavailable }
                var preset=progressive ? SpeechTranscriber.Preset.progressiveTranscription : .transcription;preset.attributeOptions.insert(.audioTimeRange)
                let transcriber=SpeechTranscriber(locale:supported,preset:preset)
                guard await AssetInventory.status(forModules:[transcriber]) == .installed else { throw SpeechFailure.modelUnavailable }
                module=transcriber
                result=Task { @MainActor in
                    for try await segment in transcriber.results {try add(segment.range,segment.text,segment.isFinal,segment.resultsFinalizationTime)}
                    return transcript.text
                }
            }
            let analyzer=SpeechAnalyzer(modules:[module]), context=AnalysisContext();context.contextualStrings[.general]=hints;try await analyzer.setContext(context)
            do {
                let audio=try AVAudioFile(forReading:URL(fileURLWithPath:file));try await analyzer.start(inputAudioFile:audio,finishAfterFile:true)
                let text=try await result.value;emit(["kind":"file-result","engine":engineName,"locale":locale,"text":text,"rawSegments":rawSegments,"contextWords":hints,"progressive":progressive,"deferredVolatile":deferredVolatile,"unmergedFinals":unmergedFinals,"needsReview":unmergedFinals>0,"recordingSaved":false]);exit(unmergedFinals>0 ? 2:0)
            } catch {result.cancel();await analyzer.cancelAndFinishNow();throw error}
        } catch {emit(["kind":"file-error","code":(error as? SpeechFailure)?.rawValue ?? "recognition-failed","rawSegments":rawSegments,"text":transcript.text,"recordingSaved":false]);exit(2)}
    }
    func info() async {
        var analyzer = false, locales: [String] = [], models: [String:String] = [:]
        if #available(macOS 26.0, *) { analyzer = SpeechTranscriber.isAvailable; if analyzer { for name in ["zh-CN","en-US"] { if let locale = await SpeechTranscriber.supportedLocale(equivalentTo:Locale(identifier:name)) { locales.append(name); let status = await AssetInventory.status(forModules:[SpeechTranscriber(locale:locale,preset:.transcription)]); models[name] = status == .installed ? "installed" : status == .downloading ? "downloading" : status == .supported ? "supported" : "unsupported" } } } }
        emit(["kind":"info","analyzerAvailable":analyzer,"locales":locales,"models":models,"microphonePermission":AVCaptureDevice.authorizationStatus(for:.audio).rawValue,"recordingSaved":false])
    }
}

@main
struct InkSpaceDictationMain {
 @MainActor static func main() {
if CommandLine.arguments.contains("--self-test") {
    var transcript = DictationTranscript(); transcript.receive(start:0,end:1,text:"你",final:false); transcript.receive(start:0,end:2,text:"你好。",final:true); transcript.receive(start:2,end:3,text:"Hello ",final:false); transcript.receive(start:2,end:4,text:"Hello world.",final:true)
    precondition(transcript.text == "你好。Hello world.")
    emit(["kind":"self-test","passed":true,"overlapReplaced":true,"duplicateFinalAvoided":true]); exit(0)
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let controller = Controller()
if CommandLine.arguments.contains("--info") || CommandLine.arguments.contains("--inspect") { Task { @MainActor in await controller.info(); exit(0) } }
else if CommandLine.arguments.contains("--prepare-model") {
    let locale: String;if let languageIndex=CommandLine.arguments.firstIndex(of:"--locale"), languageIndex+1<CommandLine.arguments.count {locale=CommandLine.arguments[languageIndex+1]}else{locale="zh-CN"}
    let timeout: Int;if let timeoutIndex=CommandLine.arguments.firstIndex(of:"--timeout"),timeoutIndex+1<CommandLine.arguments.count {timeout=min(600,max(5,Int(CommandLine.arguments[timeoutIndex+1]) ?? 60))}else{timeout=60}
    Task { @MainActor in if #available(macOS 26.0, *) { await controller.prepareModel(locale:locale,timeout:timeout) } else { emit(["kind":"model-error","code":"unavailable"]);exit(2) } }
}
else if let index = CommandLine.arguments.firstIndex(of:"--recognize-file"), index+1 < CommandLine.arguments.count {
    let file = CommandLine.arguments[index+1]
    let locale: String; if let languageIndex = CommandLine.arguments.firstIndex(of:"--locale"), languageIndex+1 < CommandLine.arguments.count { locale = CommandLine.arguments[languageIndex+1] } else { locale = "zh-CN" }
    let engineName: String;if let engineIndex=CommandLine.arguments.firstIndex(of:"--engine"),engineIndex+1<CommandLine.arguments.count {engineName=CommandLine.arguments[engineIndex+1]}else{engineName="dictation"}
    let hints: [String];if let hintsIndex=CommandLine.arguments.firstIndex(of:"--hints"),hintsIndex+1<CommandLine.arguments.count {hints=CommandLine.arguments[hintsIndex+1].split(separator:",").map(String.init).filter{$0.utf16.count<=80}.prefix(100).map{$0}}else{hints=[]}
    Task { @MainActor in if #available(macOS 26.0, *) { await controller.recognizeFile(file,locale:locale,engineName:engineName,hints:hints,progressive:CommandLine.arguments.contains("--progressive")) } else { emit(["kind":"file-error","code":"unavailable"]); exit(2) } }
}
else {
    DispatchQueue.global(qos:.userInitiated).async {
        while let line = readLine(strippingNewline:true) { if let data = line.data(using:.utf8) { Task { @MainActor in await controller.command(data) } } }
        Task { @MainActor in await controller.run?.cancel(); exit(0) }
    }
}
application.run()

 }
}
