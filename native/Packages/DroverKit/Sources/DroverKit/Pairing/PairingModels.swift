import Foundation

/// The two tokens a pairing hands over. Never printed: `description`, `debugDescription` and the mirror
/// (`dump`, or printing a value that contains this one) show neither value.
public struct PairingTokens: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    /// The main token (every op).
    public let main: String
    /// The read-only widget token (`native.summary`, `native.notifications`); nil when the daemon sent none.
    public let widget: String?

    public init(main: String, widget: String?) {
        self.main = main
        self.widget = widget
    }

    public var description: String { "PairingTokens(redacted)" }
    public var debugDescription: String { description }
    public var customMirror: Mirror { Mirror(self, children: [:], displayStyle: .struct) }
}

/// Where a pairing stands. `PairingClient.states` yields requesting, then waiting, then one final state.
public enum PairingState: Sendable, Equatable, CustomStringConvertible {
    case idle
    case requesting
    /// Show `code` (`PairingCode.formatted`) until `expiresAt`, on this device's clock.
    case waiting(code: String, expiresAt: Date)
    case approved(PairingTokens)
    case denied
    case expired
    /// A sentence for the user. Never contains a token or the request id.
    case failed(String)

    /// requesting or waiting.
    public var isActive: Bool {
        switch self {
        case .requesting, .waiting: true
        default: false
        }
    }

    public var description: String {
        switch self {
        case .idle: "idle"
        case .requesting: "requesting"
        case .waiting(let code, let expiresAt): "waiting(code: \(code), expiresAt: \(expiresAt))"
        case .approved: "approved(tokens redacted)"
        case .denied: "denied"
        case .expired: "expired"
        case .failed(let message): "failed(\(message))"
        }
    }
}

/// A request the daemon is holding. The request id is the client's secret: internal, kept in memory only, and left
/// out of `description` and the mirror.
public struct PairingTicket: Sendable, Equatable, CustomStringConvertible, CustomReflectable {
    let requestId: String
    /// The digits to show (`PairingCode.formatted`).
    public let code: String
    /// When the code lapses, on this device's clock.
    public let expiresAt: Date
    /// How often to ask for the outcome (the daemon's `pollMs`, clamped).
    public let pollInterval: Duration

    public var description: String { "PairingTicket(code: \(code), expiresAt: \(expiresAt))" }
    public var customMirror: Mirror {
        Mirror(self, children: ["code": code, "expiresAt": expiresAt, "pollInterval": pollInterval], displayStyle: .struct)
    }
}

/// One answer of `GET /api/pair/status`.
public enum PairingStatus: Sendable, Equatable {
    /// Nobody has answered yet. `expiresAt` is on this device's clock, nil when the daemon sent none.
    case pending(expiresAt: Date?)
    /// Approved on the Mac. The daemon hands the tokens over once, then forgets the request.
    case approved(PairingTokens)
    case denied
    /// Unknown, lapsed or already collected (HTTP 404).
    case expired
}

/// Why a pairing could not go on. Messages are for the user and never contain a token or the request id.
public enum PairingError: Error, Sendable, Equatable, LocalizedError {
    /// The server address is not an http or https URL.
    case invalidURL
    /// The daemon has no pairing endpoint: a Drover from before pairing answers 401 (or 404).
    case unsupported
    /// HTTP 429: too many pairing requests are pending, or they came too fast.
    case tooManyRequests
    /// Another 4xx: the daemon refused the request.
    case refused(status: Int, message: String?)
    /// A 5xx (or 408 or 429 while polling): worth asking again.
    case server(status: Int, message: String?)
    /// The answer did not match the contract. Names the field, never a value.
    case badResponse(String)
    /// No answer (URLError and friends).
    case transport(String)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .invalidURL: "Use an http or https server address."
        case .unsupported: "This daemon does not offer pairing. Update Drover on your Mac, or enter the tokens by hand."
        case .tooManyRequests: "Too many pairing requests are waiting. Approve or deny them on your Mac, or try again in a few minutes."
        case .refused(let status, let m): Self.sentence("The daemon refused to pair (HTTP \(status))", m)
        case .server(let status, let m): Self.sentence("The daemon answered HTTP \(status)", m)
        case .badResponse(let what): "Unexpected answer from the daemon (\(what))."
        case .transport(let m): Self.sentence("Could not reach the daemon", m)
        case .cancelled: "Cancelled."
        }
    }

    /// The next poll may get an answer: a network blip, a daemon restart in progress, a busy proxy.
    public var isTransient: Bool {
        switch self {
        case .server, .transport: true
        default: false
        }
    }

    private static func sentence(_ head: String, _ detail: String?) -> String {
        guard let detail, !detail.isEmpty else { return head + "." }
        return head + ": " + detail + (".!?".contains(detail.last ?? " ") ? "" : ".")
    }
}

/// How clients show a pairing code.
public enum PairingCode {
    /// "123456" -> "123 456": groups of three, the way the daemon's notification and browser UI show it.
    public static func formatted(_ code: String) -> String {
        var out = ""
        for (i, ch) in code.enumerated() {
            if i > 0 && i % 3 == 0 { out.append(" ") }
            out.append(ch)
        }
        return out
    }

    /// The terminal command that approves `code` on the daemon's Mac.
    public static func approveCommand(_ code: String) -> String { "drover pair approve \(code)" }

    /// The line under the code. Markdown: the command is inline code.
    public static func instructions(_ code: String) -> String {
        "Approve this code on your Mac: run `\(approveCommand(code))` or use Approve in Drover's browser UI."
    }

    /// For VoiceOver: one digit at a time, a pause between the groups ("1 2 3, 4 5 6").
    public static func spoken(_ code: String) -> String {
        formatted(code).split(separator: " ").map { $0.map(String.init).joined(separator: " ") }.joined(separator: ", ")
    }
}
