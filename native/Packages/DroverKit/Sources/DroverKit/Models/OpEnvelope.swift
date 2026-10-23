import Foundation

/// The `{ ok, result, ms, cache }` / `{ ok: false, error }` body of every `/api/op/<op>` response.
/// A 401 body is `{ error }` with no `ok`, so `ok` is optional.
public struct OpEnvelope<Result: Decodable & Sendable>: Decodable, Sendable {
    public var ok: Bool?
    public var result: Result?
    public var error: String?
    public var ms: Double?
    public var cache: JSONValue?

    private enum CodingKeys: String, CodingKey { case ok, result, error, ms, cache }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        ms = try c.decodeIfPresent(Double.self, forKey: .ms)
        cache = try c.decodeIfPresent(JSONValue.self, forKey: .cache)
        // An explicit `result: null` is a real answer for JSONValue (e.g. an unknown id); for a model it stays nil.
        if c.contains(.result) {
            result = try c.decodeNil(forKey: .result) ? (try? c.decode(Result.self, forKey: .result)) : c.decode(Result.self, forKey: .result)
        } else {
            result = nil
        }
    }
}
