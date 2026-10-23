import Foundation

/// Deep links into the apps (CONTRACT.md): `drover://session/<id>?host=<host>` and `drover://board`.
/// The session id is one path segment: everything outside RFC 3986 unreserved characters is percent-encoded.
enum DroverDeepLink: Equatable, Sendable {
    case session(id: String, host: String?)
    case board

    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    var url: URL {
        var components = URLComponents()
        components.scheme = SharedConfig.urlScheme
        switch self {
        case .board:
            components.host = "board"
        case let .session(id, host):
            components.host = "session"
            let encoded = id.addingPercentEncoding(withAllowedCharacters: Self.unreserved) ?? ""
            components.percentEncodedPath = "/" + encoded
            if let host, !host.isEmpty {
                components.queryItems = [URLQueryItem(name: "host", value: host)]
            }
        }
        return components.url ?? URL(string: "drover://board")!
    }

    init?(url: URL) {
        guard url.scheme?.lowercased() == SharedConfig.urlScheme,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host?.lowercased() else { return nil }
        switch host {
        case "board":
            self = .board
        case "session":
            let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
            // A leading "/" yields an empty first element; exactly one non-empty segment must follow.
            guard segments.count == 2, segments[0].isEmpty, !segments[1].isEmpty,
                  let id = String(segments[1]).removingPercentEncoding, !id.isEmpty else { return nil }
            let hostValue = components.queryItems?.first { $0.name == "host" }?.value
            self = .session(id: id, host: (hostValue?.isEmpty ?? true) ? nil : hostValue)
        default:
            return nil
        }
    }
}
