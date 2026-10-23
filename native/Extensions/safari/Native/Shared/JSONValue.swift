import Foundation

/// Minimal JSON tree used by the native messaging protocol. Bridges to and from the
/// `[String: Any]` / `NSNumber` world of `SFExtensionMessageKey` payloads.
enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    struct BridgeError: Error, Equatable, Sendable {}

    /// Build from a Foundation value (`NSNull`, `NSNumber`, `String`, arrays, dictionaries).
    /// `NSNumber` booleans (CFBoolean) become `.bool`; every other number becomes `.number`.
    init(any value: Any) throws {
        switch value {
        case is NSNull:
            self = .null
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                self = .bool(n.boolValue)
            } else {
                let d = n.doubleValue
                guard d.isFinite else { throw BridgeError() }
                self = .number(d)
            }
        case let s as String:
            self = .string(s)
        case let a as [Any]:
            self = .array(try a.map { try JSONValue(any: $0) })
        case let d as [String: Any]:
            self = .object(try d.mapValues { try JSONValue(any: $0) })
        default:
            throw BridgeError()
        }
    }

    /// Foundation representation suitable for `JSONSerialization` and `SFExtensionMessageKey`.
    /// Integral numbers become `Int` so they serialize without a fractional part.
    var anyValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let d): return Self.isIntegral(d) ? Int(d) : d
        case .string(let s): return s
        case .array(let a): return a.map { $0.anyValue }
        case .object(let o): return o.mapValues { $0.anyValue }
        }
    }

    private static func isIntegral(_ d: Double) -> Bool {
        d.isFinite && d == d.rounded() && abs(d) < 9_007_199_254_740_992
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let d = try? c.decode(Double.self) { self = .number(d) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let d):
            if Self.isIntegral(d) { try c.encode(Int64(d)) } else { try c.encode(d) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Compact JSON text with sorted keys (stable output).
    var jsonText: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self), let text = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return text
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}
