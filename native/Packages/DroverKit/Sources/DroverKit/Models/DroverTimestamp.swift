import Foundation

/// A point in time as Drover sends it. `native.*` ops send ISO 8601 strings; older ops send epoch
/// numbers (Claude in milliseconds, Codex in seconds). Decodes all three; encodes ISO 8601 with
/// fractional seconds so a cached `native.summary` round-trips to the same shape the server sent.
public struct DroverTimestamp: Sendable, Hashable, Comparable, Codable {
    public var date: Date

    public init(_ date: Date) { self.date = date }

    /// Epoch number: values above 1e11 are milliseconds, else seconds.
    public init(epoch value: Double) {
        self.date = Date(timeIntervalSince1970: value > 1e11 ? value / 1000 : value)
    }

    public init?(iso string: String) {
        guard let d = Self.parseISO(string) else { return nil }
        self.init(d)
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Double.self) { self.init(epoch: n); return }
        let s = try c.decode(String.self)
        if let d = Self.parseISO(s) { self.init(d); return }
        if let n = Double(s) { self.init(epoch: n); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a timestamp: \(s)")
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(isoString)
    }

    public var isoString: String { date.formatted(Self.isoFractional) }

    public static func < (a: DroverTimestamp, b: DroverTimestamp) -> Bool { a.date < b.date }

    private static let isoFractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let isoPlain = Date.ISO8601FormatStyle()

    private static func parseISO(_ s: String) -> Date? {
        (try? isoFractional.parse(s)) ?? (try? isoPlain.parse(s))
    }
}
