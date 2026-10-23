import Foundation

/// Any JSON value, for loosely shaped server fields we only display or pass through.
enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }
    var double: Double? { if case .number(let n) = self { return n }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
}

/// A timestamp the server sends either as an ISO 8601 string or as epoch milliseconds.
struct LooseDate: Codable, Sendable, Hashable, Comparable {
    let date: Date

    init(_ date: Date) { self.date = date }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let ms = try? c.decode(Double.self) {
            // Heuristic: values below 1e11 are seconds, above are milliseconds.
            date = Date(timeIntervalSince1970: ms > 1e11 ? ms / 1000 : ms)
        } else {
            let s = try c.decode(String.self)
            guard let d = LooseDate.parse(s) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "unparseable date")
            }
            date = d
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(LooseDate.isoFractional.string(from: date))
    }

    static func < (a: LooseDate, b: LooseDate) -> Bool { a.date < b.date }

    nonisolated(unsafe) private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ s: String) -> Date? {
        isoFractional.date(from: s) ?? isoPlain.date(from: s) ?? Double(s).map {
            Date(timeIntervalSince1970: $0 > 1e11 ? $0 / 1000 : $0)
        }
    }
}

/// A string the server may send as a JSON string or a number (cursors, offsets, ids).
struct LooseString: Codable, Sendable, Hashable {
    let value: String
    init(_ value: String) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else if let i = try? c.decode(Int.self) { value = String(i) }
        else { value = String(try c.decode(Double.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}

extension KeyedDecodingContainer {
    /// Decodes an optional field, treating a type mismatch as absent (the server's shapes vary by engine).
    func lenient<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}
