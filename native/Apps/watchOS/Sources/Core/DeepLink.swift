import Foundation

/// `drover://session/<id>?host=<host>`, `drover://board`, `drover://manager` (CONTRACT.md).
enum DeepLink: Equatable, Sendable {
    case board
    case manager
    case session(id: String, host: String?)

    init?(url: URL) {
        guard url.scheme?.lowercased() == DroverIdentifiers.urlScheme else { return nil }
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        switch url.host?.lowercased() {
        case "board": self = .board
        case "manager": self = .manager
        case "session":
            // Split the still-encoded path so an id containing %2F stays one component.
            let first = (c?.percentEncodedPath ?? "").split(separator: "/").first.map(String.init) ?? ""
            guard let id = first.removingPercentEncoding, !id.isEmpty else { return nil }
            let host = c?.queryItems?.first(where: { $0.name == "host" })?.value
            self = .session(id: id, host: (host?.isEmpty ?? true) ? nil : host)
        default: return nil
        }
    }

    var url: URL {
        var c = URLComponents()
        c.scheme = DroverIdentifiers.urlScheme
        switch self {
        case .board: c.host = "board"
        case .manager: c.host = "manager"
        case .session(let id, let host):
            c.host = "session"
            var allowed = CharacterSet.urlPathAllowed
            allowed.remove("/")
            c.percentEncodedPath = "/" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id)
            if let host { c.queryItems = [URLQueryItem(name: "host", value: host)] }
        }
        return c.url!
    }
}

enum ListRouting {
    /// The waiting item a deep link points at. An omitted host means `local` (CONTRACT.md),
    /// never "any host": a reply must not land on a same-id session on another machine.
    static func route(_ link: DeepLink, in items: [WaitingItem]) -> WaitingItem? {
        guard case .session(let id, let host) = link else { return nil }
        let want = (host?.isEmpty ?? true) ? "local" : host!
        return items.first { $0.id == id && ($0.host ?? "local") == want }
    }
}
