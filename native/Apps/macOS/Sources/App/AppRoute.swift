import Foundation

/// What a `drover://` URL asks for (CONTRACT.md URL scheme). Pure, harness-tested.
///
/// - `drover://session/<id>?host=<h>`: that session in the main window (host optional, default local).
/// - `drover://board`: the board in the main window.
/// - `drover://manager`: the floating manager panel; `drover://manager?in=window` the manager in the main window.
/// - `drover://pair?url=<base URL>`: the main window's pairing sheet for that address (PairLinkPolicy).
/// The dev build's own scheme, `droverdev`, maps the same way, so it never needs the real app's `drover`.
enum AppRoute: Equatable, Sendable {
    case session(id: String, host: String?)
    case board
    case manager(inWindow: Bool)
    case pair(URL)
    /// Dev build only: test hooks (`droverdev://debug/<action>`).
    case debug(String, [String: String])

    static let schemes: Set<String> = ["drover", "droverdev"]

    static func parse(_ url: URL) -> AppRoute? {
        guard let scheme = url.scheme?.lowercased(), schemes.contains(scheme) else { return nil }
        let query = Dictionary(
            (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).compactMap { q in q.value.map { (q.name, $0) } },
            uniquingKeysWith: { a, _ in a })
        let first = url.pathComponents.dropFirst().first?.removingPercentEncoding
        switch url.host()?.lowercased() {
        case "session":
            guard let id = first, !id.isEmpty else { return nil }
            let host = query["host"].flatMap { $0.isEmpty ? nil : $0 }
            return .session(id: id, host: host)
        case "manager":
            return .manager(inWindow: query["in"] == "window" || first == "window")
        case "pair":
            guard let u = pairAddress(url) else { return .board }
            return .pair(u)
        case "debug":
            guard scheme == "droverdev", let action = first else { return nil }
            return .debug(action, query)
        default:
            return .board
        }
    }

    /// The daemon address of a pair link, as the iOS app reads one: exactly one parameter, `url`, an http or https URL
    /// with a host and no credentials, query or fragment, so a link never brings anything but an address.
    static func pairAddress(_ link: URL) -> URL? {
        guard let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems, items.count == 1,
              items[0].name == "url", let raw = items[0].value?.trimmingCharacters(in: .whitespacesAndNewlines),
              let c = URLComponents(string: raw), let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              c.host?.isEmpty == false, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil else { return nil }
        return c.url
    }

    /// Where it shows: the main window, or the manager panel.
    var showsPanel: Bool {
        if case .manager(let inWindow) = self { return !inWindow }
        return false
    }
}

/// What a `drover://pair?url=` link may do on its own (the iOS app's rule). A link can come from any app or web page, so
/// only pairing again with the daemon this app uses starts by itself. Any other address waits for a click on the sheet
/// that names it, and even then the server, the tokens and the App Group copy change only once that daemon approves
/// the code (AppModel.storePaired): a link never points the app, its token or the menu bar at a server by itself. Pure.
enum PairLinkPolicy {
    static func startsAutomatically(link: URL, configured: URL?) -> Bool {
        guard let configured, let a = key(configured), let b = key(link) else { return false }
        return a == b
    }

    /// The same daemon: scheme and host compare without case, the port as given, the path exactly (a proxy can route
    /// /Team and /team to different daemons), trailing slashes aside.
    static func key(_ url: URL) -> String? {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), let scheme = c.scheme?.lowercased(),
              let host = c.percentEncodedHost?.lowercased(), !host.isEmpty else { return nil }
        var path = c.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        return "\(scheme)://\(host):\(c.port.map(String.init) ?? "")\(path)"
    }

    /// The sheet's words: the address the link names, and the one in use when that is another daemon.
    static func confirmation(for link: URL, current: URL?) -> String {
        let instead = current.flatMap { startsAutomatically(link: link, configured: $0) ? nil : " instead of \($0.absoluteString)" } ?? ""
        return "A link asks Drover to pair with \(link.absoluteString). Pair only with a Mac you control: once its code is approved there, Drover, the menu bar and the Safari extension use that daemon\(instead)."
    }
}
