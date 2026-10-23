import AVFoundation
import Observation
import Speech

/// On-device dictation into the composer. Server recognition is never used: if the language has no
/// on-device model the mic is unavailable.
@MainActor
@Observable
final class DictationController {
    private(set) var isListening = false
    private(set) var errorMessage: String?

    private let recognizer: SFSpeechRecognizer?
    private var audioEngine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var baseText = ""
    private var onUpdate: (@MainActor (String) -> Void)?

    init() {
        recognizer = SFSpeechRecognizer(locale: .current)
    }

    /// True when this language can be recognised on device.
    var isAvailable: Bool {
        guard let recognizer else { return false }
        return recognizer.supportsOnDeviceRecognition
    }

    /// Starts or stops. `base` is the text before dictation; `update` receives base plus the recognised part.
    func toggle(base: String, update: @escaping @MainActor (String) -> Void) {
        if isListening { stop(); return }
        Task { await start(base: base, update: update) }
    }

    private func start(base: String, update: @escaping @MainActor (String) -> Void) async {
        errorMessage = nil
        guard let recognizer, recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            errorMessage = "On-device dictation is not available for this language."
            return
        }
        let speech = await Self.requestSpeechAuthorization()
        guard speech == .authorized else {
            errorMessage = "Allow speech recognition in Settings to dictate."
            return
        }
        let mic = await AVAudioApplication.requestRecordPermission()
        guard mic else {
            errorMessage = "Allow microphone access in Settings to dictate."
            return
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true

        let engine = AVAudioEngine()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            Self.installTap(on: engine.inputNode, request: request)
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            deactivateSession()
            errorMessage = "Dictation could not start."
            return
        }

        baseText = base
        onUpdate = update
        self.request = request
        audioEngine = engine
        isListening = true
        task = Self.makeTask(recognizer: recognizer, request: request) { [weak self] text, failed in
            Task { @MainActor in self?.handle(text: text, failed: failed) }
        }
    }

    func stop() {
        guard isListening || audioEngine != nil else { return }
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        audioEngine = nil
        onUpdate = nil
        isListening = false
        deactivateSession()
    }

    private func handle(text: String?, failed: Bool) {
        guard isListening else { return }
        if let text { onUpdate?(ComposerText.dictated(base: baseText, partial: text)) }
        if failed {
            errorMessage = "Dictation stopped."
            stop()
        }
    }

    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: off-main-actor pieces (the audio tap and recognition callbacks run on other threads)

    private nonisolated static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
        }
    }

    private nonisolated static func installTap(on node: AVAudioInputNode, request: SFSpeechAudioBufferRecognitionRequest) {
        nonisolated(unsafe) let request = request
        let format = node.outputFormat(forBus: 0)
        node.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private nonisolated static func makeTask(recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest,
                                             report: @escaping @Sendable (String?, Bool) -> Void) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            report(result?.bestTranscription.formattedString, error != nil)
        }
    }
}
