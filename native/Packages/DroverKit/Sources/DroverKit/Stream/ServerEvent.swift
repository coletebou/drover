import Foundation

/// One server-sent event from `/api/stream`.
public struct ServerEvent: Sendable, Equatable {
    public enum Kind: String, Sendable {
        case hello, mutation, notify, alerts, snapshot, fleet, probe, settings, turn, headless, codex, unknown
    }

    /// Raw event name ("message" when the server sent none).
    public let name: String
    /// Joined data lines.
    public let data: String
    public let id: String?

    public init(name: String, data: String, id: String? = nil) {
        self.name = name
        self.data = data
        self.id = id
    }

    public var kind: Kind { Kind(rawValue: name) ?? .unknown }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: Data(data.utf8))
    }
}
