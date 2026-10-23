import Foundation

/// One-tap replies. The raw value is exactly what is sent.
enum CannedReply: String, CaseIterable, Identifiable, Sendable {
    case yes
    case no
    case proceed = "continue"
    case goAhead = "go ahead"
    case status = "status?"

    var id: String { rawValue }
    var text: String { rawValue }

    var label: String {
        switch self {
        case .yes: return "Yes"
        case .no: return "No"
        case .proceed: return "Continue"
        case .goAhead: return "Go ahead"
        case .status: return "Status?"
        }
    }

    var symbol: String {
        switch self {
        case .yes: return "checkmark"
        case .no: return "xmark"
        case .proceed: return "arrow.right"
        case .goAhead: return "play.fill"
        case .status: return "questionmark"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .yes: return "Reply yes"
        case .no: return "Reply no"
        case .proceed: return "Reply continue"
        case .goAhead: return "Reply go ahead"
        case .status: return "Ask for status"
        }
    }
}

enum ReplyPhase: Equatable, Sendable {
    case idle
    case confirming(String)
    case sending(String)
    case sent(String)
    case failed(text: String, message: String)
}

/// Pure state machine for the reply bar.
struct ReplyFlow: Equatable, Sendable {
    private(set) var phase: ReplyPhase = .idle

    var isBusy: Bool {
        if case .sending = phase { return true }
        return false
    }

    /// Trim, collapse whitespace runs to one space, cap at 2000 characters.
    static func clean(_ raw: String) -> String {
        let parts = raw.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
        let joined = parts.joined(separator: " ")
        guard joined.count > 2000 else { return joined }
        let capped = String(joined.prefix(2000))
        return capped.trimmingCharacters(in: .whitespaces)
    }

    mutating func dictated(_ raw: String) {
        let cleaned = Self.clean(raw)
        guard !cleaned.isEmpty, !isBusy else { return }
        phase = .confirming(cleaned)
    }

    mutating func confirm() -> String? {
        guard case .confirming(let t) = phase else { return nil }
        phase = .sending(t)
        return t
    }

    mutating func cancel() {
        switch phase {
        case .confirming, .failed: phase = .idle
        default: break
        }
    }

    mutating func tap(_ reply: CannedReply) -> String? {
        if isBusy { return nil }
        phase = .sending(reply.text)
        return reply.text
    }

    mutating func retry() -> String? {
        guard case .failed(let t, _) = phase else { return nil }
        phase = .sending(t)
        return t
    }

    mutating func succeeded() {
        guard case .sending(let t) = phase else { return }
        phase = .sent(t)
    }

    mutating func failed(_ message: String) {
        guard case .sending(let t) = phase else { return }
        phase = .failed(text: t, message: message)
    }

    mutating func reset() { phase = .idle }
}
