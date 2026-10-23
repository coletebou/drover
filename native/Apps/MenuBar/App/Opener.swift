import AppKit

/// Opens sessions, the board and the manager in the native macOS app when it is installed (and preferred),
/// else in the web UI. One click is one deep link: a second identical open within a second (a double click,
/// a notification tapped while the popover also asked) is dropped. Never puts a token in a URL: the web UI
/// keeps its own token.
@MainActor
final class Opener {
    let preferences: @MainActor () -> MenuBarPreferences
    private var throttle = OpenThrottle()

    init(preferences: @escaping @MainActor () -> MenuBarPreferences) {
        self.preferences = preferences
    }

    private var useMainApp: Bool {
        preferences().openTarget == .mainAppThenWeb
            && NSWorkspace.shared.urlForApplication(withBundleIdentifier: AppIdentifiers.mainAppBundleID) != nil
    }

    func openSession(id: String, host: String, engine: String = "", name: String = "") {
        if useMainApp {
            open(Links.appSession(id, host: host))
        } else if let base = preferences().baseURL {
            open(Links.webSession(base: base, id: id, host: host, engine: engine, name: name.isEmpty ? id : name))
        }
    }

    func openDashboard() {
        if useMainApp {
            open(Links.appBoard)
        } else if let base = preferences().baseURL {
            open(Links.webBoard(base: base))
        }
    }

    func openManager() {
        if useMainApp {
            open(Links.appManager)
        } else if let base = preferences().baseURL {
            open(Links.webManager(base: base))
        }
    }

    private func open(_ url: URL) {
        guard throttle.allow(url) else { return }
        #if DROVER_DEV
        // A dev build never drives the real Drover app or browser unless asked (DROVER_DEV_OPEN=1).
        DevHarness.opened.append(url)
        guard DevEnvironment.opensURLs else {
            DevHarness.log("would open \(url.scheme ?? "")://\(url.host() ?? "")\(url.path())")
            return
        }
        #endif
        // One open, handed to the app that owns the scheme; it activates itself.
        NSWorkspace.shared.open(url)
    }
}
