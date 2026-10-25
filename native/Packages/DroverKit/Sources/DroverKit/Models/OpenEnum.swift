import Foundation

// String-backed "open" enums: known values are static members, unknown values decode without
// failing (the server adds kinds over time; clients must not break on them).

public struct Engine: RawRepresentable, Sendable, Hashable, Codable, CustomStringConvertible {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { self.rawValue = raw }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var description: String { rawValue }

    public static let claude = Engine("claude")
    public static let codex = Engine("codex")
    public static let headless = Engine("headless")
    public static let openclaw = Engine("openclaw")
    /// A Hermes Agent session (Nous Research), read and answered through its gateway.
    public static let hermes = Engine("hermes")
    public static let shell = Engine("shell")
}

/// Why a session waits (`native.summary` `waiting[].kind`).
public struct AskKind: RawRepresentable, Sendable, Hashable, Codable, CustomStringConvertible {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { self.rawValue = raw }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var description: String { rawValue }

    /// A dialog or held peer message is on screen: pick an option.
    public static let decision = AskKind("decision")
    /// The agent asked a question (AskUserQuestion, or its last reply ends with one).
    public static let question = AskKind("question")
    /// The agent finished; nothing is pending.
    public static let finished = AskKind("finished")
}

/// `native.notifications` item `kind`.
public struct NotificationKind: RawRepresentable, Sendable, Hashable, Codable, CustomStringConvertible {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { self.rawValue = raw }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var description: String { rawValue }

    public static let decision = NotificationKind("decision")
    public static let question = NotificationKind("question")
    public static let finished = NotificationKind("finished")
    public static let error = NotificationKind("error")
    public static let mr = NotificationKind("mr")
    public static let launch = NotificationKind("launch")
    public static let manager = NotificationKind("manager")

    /// Decision and question items want an answer from the owner.
    public var needsYou: Bool { self == .decision || self == .question }
}

/// The web UI's alert category (drives per-category sound settings).
public struct NotificationCategory: RawRepresentable, Sendable, Hashable, Codable, CustomStringConvertible {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { self.rawValue = raw }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var description: String { rawValue }

    public static let needsYou = NotificationCategory("needs-you")
    public static let finished = NotificationCategory("finished")
    public static let error = NotificationCategory("error")
    public static let held = NotificationCategory("held")
    public static let mr = NotificationCategory("mr")
    public static let launch = NotificationCategory("launch")
    public static let manager = NotificationCategory("manager")
    public static let all: [NotificationCategory] = [.needsYou, .finished, .error, .held, .mr, .launch, .manager]
}

/// Transcript turn role.
public struct TurnRole: RawRepresentable, Sendable, Hashable, Codable, CustomStringConvertible {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ raw: String) { self.rawValue = raw }
    public init(from decoder: any Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public var description: String { rawValue }

    public static let user = TurnRole("user")
    public static let assistant = TurnRole("assistant")
    public static let toolResult = TurnRole("tool_result")
    public static let tool = TurnRole("tool")
    public static let thinking = TurnRole("thinking")
    public static let title = TurnRole("title")
    public static let queue = TurnRole("queue")
    public static let result = TurnRole("result")
    public static let system = TurnRole("system")
}
