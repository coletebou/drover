import Foundation

/// Lenient JSON tree. The daemon's payloads drift (optional keys, ints vs strings), so the macOS app
/// decodes into this and maps by hand instead of failing a whole board on one odd field.
enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// Parse response bytes. JSONSerialization plus one conversion pass: several times faster than `JSONDecoder` on
    /// this type, whose `init(from:)` has to try each case in turn (a 1.3 MB fleet.summary took most of a second).
    /// Callers run it off the main actor (LiveDroverService, the SSE delegate queue).
    static func parse(_ data: Data) throws -> JSONValue {
        JSONValue(any: try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
    }

    init(any: Any) {
        switch any {
        case let s as String: self = .string(s)
        case let n as NSNumber:
            self = CFGetTypeID(n) == CFBooleanGetTypeID() ? .bool(n.boolValue) : .number(n.doubleValue)
        case let a as [Any]: self = .array(a.map(JSONValue.init(any:)))
        case let o as [String: Any]: self = .object(o.mapValues(JSONValue.init(any:)))
        default: self = .null
        }
    }

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
        if case .object(let o) = self { return o[key] } else { return nil }
    }

    var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }
    /// Non-empty string or nil.
    var text: String? { string.flatMap { $0.isEmpty ? nil : $0 } }
    var int: Int? {
        switch self {
        case .number(let n): return Int(n)
        case .string(let s): return Int(s)
        default: return nil
        }
    }
    var bool: Bool? {
        switch self {
        case .bool(let b): return b
        case .number(let n): return n != 0
        case .string(let s): return s == "true" ? true : s == "false" ? false : nil
        default: return nil
        }
    }
    var array: [JSONValue] { if case .array(let a) = self { return a } else { return [] } }
    var object: [String: JSONValue]? { if case .object(let o) = self { return o } else { return nil } }
    /// Not null and not missing.
    var isPresent: Bool { self != .null }
    /// Strings of an array (non-strings dropped).
    var strings: [String] { array.compactMap(\.text) }

    /// Compact JSON text (sorted keys), for showing a tool input.
    var compactJSON: String {
        if case .string(let s) = self { return s }
        guard let data = try? JSONEncoder.sorted.encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// ISO-8601 string or epoch milliseconds.
    var date: Date? {
        switch self {
        case .number(let n): return Date(timeIntervalSince1970: n > 1e11 ? n / 1000 : n)
        case .string(let s):
            if let d = JSONValue.isoFrac.date(from: s) ?? JSONValue.iso.date(from: s) { return d }
            if let n = Double(s) { return JSONValue.number(n).date }
            return nil
        default: return nil
        }
    }

    nonisolated(unsafe) private static let iso: ISO8601DateFormatter = ISO8601DateFormatter()
    nonisolated(unsafe) private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
}

private extension JSONEncoder {
    static var sorted: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
                     ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral {
    init(stringLiteral v: String) { self = .string(v) }
    init(integerLiteral v: Int) { self = .number(Double(v)) }
    init(booleanLiteral v: Bool) { self = .bool(v) }
    init(dictionaryLiteral elements: (String, JSONValue)...) { self = .object(Dictionary(uniqueKeysWithValues: elements)) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}
