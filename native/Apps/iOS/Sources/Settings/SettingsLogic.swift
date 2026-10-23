import Foundation

// Pure logic of the settings tab (Foundation only).

/// Wording of the "Test connection" result.
enum SettingsConnectionTest {
    struct Outcome: Equatable, Sendable {
        var ok: Bool
        var text: String
    }

    /// `sessionsError` is nil when sessions(host: nil) succeeded.
    static func outcome(hostCount: Int, sessionsError: Error?) -> Outcome {
        let hosts = "Connected: \(hostCount) \(hostCount == 1 ? "host" : "hosts")"
        guard let e = sessionsError else { return Outcome(ok: true, text: hosts + ". Main token works.") }
        if let api = e as? DroverError, api == .forbidden {
            return Outcome(ok: true, text: hosts + ". Read-only token (widget scope).")
        }
        return Outcome(ok: false, text: hosts + ", but listing sessions failed: " + e.localizedDescription)
    }

    static func failure(_ error: Error) -> Outcome { Outcome(ok: false, text: error.localizedDescription) }
}

/// What a `drover://pair?url=` link may do on its own.
enum PairLinkPolicy {
    /// Only pairing again with the daemon this app is already set up for starts by itself. Any other address, and
    /// every address on a fresh install, is filled in and waits for a tap on Pair with Mac: a link from anywhere must
    /// never quietly point the app, its tokens and the watch at a server the user did not choose.
    static func startsAutomatically(link: URL, configured: URL?) -> Bool {
        guard let configured, let a = key(configured), let b = key(link) else { return false }
        return a == b
    }

    /// Shown (and announced) while a link's address waits for that tap.
    static func confirmation(for link: URL) -> String {
        "A link asks to pair with \(link.absoluteString). Pair only with a Mac you control: check the address, then tap Pair with Mac."
    }

    /// The same daemon: scheme and host compare without case, the port as given, the path exactly (a proxy can
    /// route /Team and /team to different daemons), trailing slashes aside.
    static func key(_ url: URL) -> String? {
        guard let normalized = SharedSettings.normalizedURL(url.absoluteString),
              let c = URLComponents(url: normalized, resolvingAgainstBaseURL: false),
              let scheme = c.scheme?.lowercased(), let host = c.percentEncodedHost?.lowercased() else { return nil }
        return "\(scheme)://\(host):\(c.port.map(String.init) ?? "")\(c.percentEncodedPath)"
    }
}

/// What a pairing approval saves.
enum PairingSave {
    /// The approving daemon's widget token, or, when it sent none, delete ours: an older daemon's token must not stay,
    /// and an empty one must never be written (widgets and the watch would send it). The macOS app does the same.
    static func widgetChange(_ widget: String?) -> TokenVault.Change {
        guard let widget, !widget.isEmpty else { return .delete }
        return .store(widget)
    }
}

/// Notification kinds the user can mute, in display order.
struct SettingsNotificationKind: Equatable, Sendable, Identifiable {
    var id: String
    var label: String

    static let all: [SettingsNotificationKind] = [
        .init(id: "decision", label: "Decisions"),
        .init(id: "question", label: "Questions"),
        .init(id: "finished", label: "Finished"),
        .init(id: "error", label: "Errors"),
        .init(id: "mr", label: "Merge requests"),
        .init(id: "launch", label: "Launches"),
        .init(id: "manager", label: "Manager"),
    ]

    static func isEnabled(_ kind: String, muted: Set<String>) -> Bool { !muted.contains(kind) }

    static func updated(_ muted: Set<String>, kind: String, enabled: Bool) -> Set<String> {
        var m = muted
        if enabled { m.remove(kind) } else { m.insert(kind) }
        return m
    }
}
