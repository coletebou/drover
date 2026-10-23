import AppKit
import SwiftUI

@main
struct DroverMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model: AppModel

    init() {
        // `--mock` runs on synthetic data (MockDroverService) with no network and no Keychain access.
        let mock = CommandLine.arguments.contains("--mock")
        #if DROVER_DEV
        // The unentitled dev build: the daemon's token file and DROVER_URL, nothing shared with the signed app.
        let settings = AppSettings(group: nil)
        if !mock { settings.serverURLString = DevConfig.serverURL }
        let tokens: TokenStore = mock ? MemoryTokenStore("mock") : FileTokenStore(url: DevConfig.tokenFile)
        let widgetTokens: TokenStore = MemoryTokenStore()
        #else
        let settings = AppSettings()
        let tokens: TokenStore = mock ? MemoryTokenStore("mock") : KeychainTokenStore()
        let widgetTokens: TokenStore = mock ? MemoryTokenStore() : KeychainTokenStore(account: "widget")
        #endif
        let model = AppModel(settings: settings, tokens: tokens, widgetTokens: widgetTokens,
                             service: mock ? MockDroverService() : nil)
        // Before launch finishes: a notification action that launches the app must find the delegate set.
        model.notifications.prepare()
        WindowRouter.shared.attach(model)
        _model = State(initialValue: model)
    }

    var body: some Scene {
        // One main window. A `Window` scene has exactly one instance; URLs never reach SwiftUI (AppDelegate), so
        // nothing opens a second one.
        Window("Drover", id: WindowRouter.mainWindowID) {
            ContentView()
                .environment(model)
                .task {
                    model.start()
                    model.pairIfUnconfigured()
                }
        }
        .defaultSize(width: 1280, height: 820)
        // The content sets a minimum, never the window's size: a Window scene otherwise sizes to its content.
        .windowResizability(.contentMinSize)
        .commands { AppCommands(model: model) }

        Settings {
            SettingsView()
                .environment(model)
        }
    }
}

/// URLs, Dock clicks and the last window closing. AppKit delegate methods run on the main thread.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Ours, not SwiftUI's: a URL then never opens a window by itself (WindowRouter decides).
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleGetURL(_:withReplyEvent:)),
                                                     forEventClass: AEEventClass(kInternetEventClass),
                                                     andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { WindowRouter.shared.model?.start() }
    }

    @objc func handleGetURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let s = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let url = URL(string: s) else { return }
        MainActor.assumeIsolated { WindowRouter.shared.handle(url: url) }
    }

    /// The app posts notifications and keeps the manager panel: it stays running with no window open.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// A Dock click (or `open` on the running app) with the main window closed brings it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated {
            let router = WindowRouter.shared
            if router.mainWindow()?.isVisible != true { router.showMain() }
        }
        return false
    }
}
