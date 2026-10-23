import Foundation

/// Pure helpers for composing a message with attachments.
enum ComposerText {
    static let maxSide: Double = 2048
    static let maxBytes = 20 * 1024 * 1024

    /// Appends one "[Attached image: <path>] Read it with the Read tool." line per uploaded file.
    static func build(text: String, paths: [String]) -> String {
        let base = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !paths.isEmpty else { return base }
        let lines = paths.map { "[Attached image: \($0)] Read it with the Read tool." }.joined(separator: "\n")
        return base.isEmpty ? lines : base + "\n\n" + lines
    }

    static func canSend(text: String, attachmentCount: Int) -> Bool {
        attachmentCount > 0 || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func isTooLarge(_ bytes: Int) -> Bool { bytes > maxBytes }

    /// Scales (w, h) down so the longest side is at most `maxSide`, keeping the aspect ratio. Never upscales.
    static func fitSize(_ w: Double, _ h: Double, maxSide: Double) -> (Double, Double) {
        guard w > 0, h > 0, maxSide > 0 else { return (max(w, 0), max(h, 0)) }
        let longest = max(w, h)
        guard longest > maxSide else { return (w, h) }
        let scale = maxSide / longest
        return ((w * scale).rounded(), (h * scale).rounded())
    }

    /// Text after dictation: what existed before plus the recognised part, separated by a space.
    static func dictated(base: String, partial: String) -> String {
        let p = partial.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return base }
        if base.isEmpty || base.hasSuffix(" ") || base.hasSuffix("\n") { return base + p }
        return base + " " + p
    }
}
