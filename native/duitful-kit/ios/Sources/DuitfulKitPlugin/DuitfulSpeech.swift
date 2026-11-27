import Foundation
import Speech
import AVFoundation

/// "Talk to Kira" (1.80.0): Apple's Speech framework turns a short spoken
/// spend into text for the Voice sheet.
///
/// On-device only. A language whose recogniser can't run on this iPhone
/// (`supportsOnDeviceRecognition` false) is reported as unavailable and the
/// mic stays hidden for it, so audio is never sent to Apple's servers:
/// `requiresOnDeviceRecognition` is always true. Nothing is recorded or
/// kept; the audio buffers go straight into the recogniser and the text goes
/// back to the app.
///
/// One listen at a time, at most `maxSeconds` (30 s), ended early by
/// `silenceSeconds` without a new word, by the person letting go of Kira or
/// tapping the mic (`stop`), or by the app leaving the foreground. The audio
/// session is deactivated every time, so other apps' audio comes back.
final class DuitfulSpeech {
    static let shared = DuitfulSpeech()
    static let maxSeconds: TimeInterval = 30
    /// No new words for this long after the first one: done.
    static let silenceSeconds: TimeInterval = 2.2
    /// Nothing heard at all for this long: done.
    static let firstWordSeconds: TimeInterval = 8

    struct Failure: Error {
        let code: String
        let message: String
    }

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var onPartial: ((String) -> Void)?
    private var onFinish: ((Result<String, Failure>) -> Void)?
    private var lastText = ""
    private var maxTimer: Timer?
    private var silenceTimer: Timer?
    private var generation = 0

    /// The recogniser to use for a BCP-47 tag: that locale if it runs on this
    /// iPhone, else another region of the same language that does (en-MY →
    /// en-GB / en-US …), else nil.
    static func recognizer(for tag: String) -> SFSpeechRecognizer? {
        let wanted = tag.replacingOccurrences(of: "_", with: "-")
        if let r = SFSpeechRecognizer(locale: Locale(identifier: wanted)), r.supportsOnDeviceRecognition {
            return r
        }
        let language = wanted.split(separator: "-").first.map(String.init)?.lowercased() ?? wanted.lowercased()
        let candidates = SFSpeechRecognizer.supportedLocales()
            .map { $0.identifier.replacingOccurrences(of: "_", with: "-") }
            .filter { $0.lowercased() == language || $0.lowercased().hasPrefix(language + "-") }
            .sorted()
        for id in candidates {
            if let r = SFSpeechRecognizer(locale: Locale(identifier: id)), r.supportsOnDeviceRecognition {
                return r
            }
        }
        return nil
    }

    /// {available, onDevice, locale}. available is false unless the words can
    /// be heard on the phone itself.
    static func status(lang: String) -> [String: Any] {
        guard let r = recognizer(for: lang) else {
            return ["available": false, "onDevice": false, "reason": "not-on-device"]
        }
        let auth = SFSpeechRecognizer.authorizationStatus()
        if auth == .denied || auth == .restricted {
            return ["available": true, "onDevice": true, "locale": r.locale.identifier, "reason": "denied"]
        }
        return ["available": r.isAvailable, "onDevice": true, "locale": r.locale.identifier, "reason": ""]
    }

    /// Speech recognition, then the microphone. Answers on the main queue.
    static func authorize(_ done: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                DispatchQueue.main.async { done(false) }
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async { done(granted) }
            }
        }
    }

    /// Main queue only.
    func start(lang: String,
               partial: @escaping (String) -> Void,
               finish: @escaping (Result<String, Failure>) -> Void) {
        guard onFinish == nil else {
            finish(.failure(Failure(code: "BUSY", message: "Already listening")))
            return
        }
        guard let r = Self.recognizer(for: lang), r.isAvailable else {
            finish(.failure(Failure(code: "UNAVAILABLE", message: "Speech isn't available on this iPhone for this language")))
            return
        }
        generation += 1
        onPartial = partial
        onFinish = finish
        lastText = ""
        recognizer = r

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            end(.failure(Failure(code: "SPEECH", message: "The microphone is busy")))
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        // Never Apple's servers: the words are heard on this iPhone or not at all.
        req.requiresOnDeviceRecognition = true
        req.taskHint = .dictation
        request = req

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            end(.failure(Failure(code: "SPEECH", message: "No microphone input")))
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buffer, _ in
            req?.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            end(.failure(Failure(code: "SPEECH", message: "Could not start the microphone")))
            return
        }

        let mine = generation
        task = r.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.generation == mine, self.onFinish != nil else { return }
                if let result = result {
                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty && text != self.lastText {
                        self.lastText = text
                        self.onPartial?(text)
                        self.arm(silence: Self.silenceSeconds)
                    }
                    if result.isFinal {
                        self.end(.success(text.isEmpty ? self.lastText : text))
                        return
                    }
                }
                if error != nil {
                    // "No speech detected" and the like: whatever was heard.
                    self.end(.success(self.lastText))
                }
            }
        }

        maxTimer = Timer.scheduledTimer(withTimeInterval: Self.maxSeconds, repeats: false) { [weak self] _ in
            self?.stop()
        }
        arm(silence: Self.firstWordSeconds)
    }

    /// Let go, tap the mic, silence or time up: finish with what was heard.
    /// Main queue only.
    func stop() {
        guard onFinish != nil else { return }
        stopAudio()
        request?.endAudio()
        // The final result normally follows endAudio within a moment.
        let mine = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self = self, self.generation == mine else { return }
            self.end(.success(self.lastText))
        }
    }

    private func arm(silence seconds: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.stop()
        }
    }

    private func stopAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
    }

    private func end(_ result: Result<String, Failure>) {
        guard let finish = onFinish else { return }
        onFinish = nil
        onPartial = nil
        maxTimer?.invalidate()
        maxTimer = nil
        silenceTimer?.invalidate()
        silenceTimer = nil
        stopAudio()
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        finish(result)
    }
}
