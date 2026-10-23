import Foundation

enum NativeError: String, Error, Sendable, Equatable {
    case badRequest
    case unknownType
    case notConfigured
    case notAuthorized
    case network
}

struct NotifyPayload: Sendable, Equatable {
    var id: String
    var title: String
    var body: String
    var sessionId: String?
    var host: String?
    var kind: String?
}

struct OpPayload: Sendable, Equatable {
    var op: String
    var method: String
    var args: [String: JSONValue]
    /// Origin the page meant to reach (`scheme://host[:port]`). When set and different from the shared
    /// server, the request is refused instead of being retargeted to a server the page never saw.
    var origin: String? = nil
    /// A token the page is testing (the options page). Used instead of the stored one for this request only;
    /// never stored, never echoed back.
    var token: String? = nil
}

enum NativeRequest: Sendable, Equatable {
    case ping
    case config
    case notify(NotifyPayload)
    case clearNotification(id: String)
    case op(OpPayload)

    /// Parse the raw `SFExtensionMessageKey` value. The protocol version `v` is not checked
    /// (forward compatible); `type` must be a string.
    static func parse(_ message: Any?) -> Result<NativeRequest, NativeError> {
        guard let message, let dict = message as? [String: Any] else { return .failure(.badRequest) }
        guard let type = dict["type"] as? String else { return .failure(.badRequest) }

        switch type {
        case "ping":
            return .success(.ping)
        case "config":
            return .success(.config)
        case "notify":
            guard let id = dict["id"] as? String, let title = dict["title"] as? String,
                  let body = dict["body"] as? String else { return .failure(.badRequest) }
            guard let sessionId = optionalString(dict["sessionId"]),
                  let host = optionalString(dict["host"]),
                  let kind = optionalString(dict["kind"]) else { return .failure(.badRequest) }
            return .success(.notify(NotifyPayload(
                id: id, title: title, body: body,
                sessionId: sessionId.value, host: host.value, kind: kind.value)))
        case "clearNotification":
            guard let id = dict["id"] as? String else { return .failure(.badRequest) }
            return .success(.clearNotification(id: id))
        case "op":
            guard let op = dict["op"] as? String,
                  let method = dict["method"] as? String, method == "GET" || method == "POST"
            else { return .failure(.badRequest) }
            var args: [String: JSONValue] = [:]
            if let raw = dict["args"], !(raw is NSNull) {
                guard let rawDict = raw as? [String: Any],
                      case .object(let parsed)? = try? JSONValue(any: rawDict)
                else { return .failure(.badRequest) }
                args = parsed
            }
            var origin: String?
            if let raw = dict["origin"], !(raw is NSNull) {
                guard let s = raw as? String else { return .failure(.badRequest) }
                origin = s
            }
            var token: String?
            if let raw = dict["token"], !(raw is NSNull) {
                guard let s = raw as? String, !s.isEmpty else { return .failure(.badRequest) }
                token = s
            }
            return .success(.op(OpPayload(op: op, method: method, args: args, origin: origin, token: token)))
        default:
            return .failure(.unknownType)
        }
    }

    /// Missing or null gives `.some(nil)`; a string gives `.some(value)`; anything else gives `nil` (invalid).
    private static func optionalString(_ raw: Any?) -> Box? {
        guard let raw, !(raw is NSNull) else { return Box(value: nil) }
        guard let s = raw as? String else { return nil }
        return Box(value: s)
    }

    private struct Box { let value: String? }
}

enum NativeResponse: Sendable {
    case success(JSONValue)
    case failure(NativeError)

    var jsonObject: [String: Any] {
        switch self {
        case .success(let value): return ["ok": true, "result": value.anyValue]
        case .failure(let error): return ["ok": false, "error": error.rawValue]
        }
    }
}
