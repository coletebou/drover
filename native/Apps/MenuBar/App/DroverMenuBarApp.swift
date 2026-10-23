import SwiftUI
import WidgetKit

/// Drover menu bar: a lightweight LSUIElement app with a `MenuBarExtra` (window style) showing what is
/// waiting on you and the manager, plus a Settings scene. All state lives in `AppModel`.
@main
struct DroverMenuBarApp: App {
    @State private var model = AppModel()
    #if DROVER_DEV
    // A dev build shows no menu bar item unless asked (DROVER_DEV_MENUBAR=1): its harness renders offscreen.
    @State private var showsItem = DevEnvironment.showsMenuBarItem
    #endif

    var body: some Scene {
        #if DROVER_DEV
        MenuBarExtra(isInserted: $showsItem) {
            PopoverHost(model: model)
        } label: {
            MenuBarLabel(badge: model.store.badge)
        }
        .menuBarExtraStyle(.window)
        #else
        MenuBarExtra {
            PopoverHost(model: model)
        } label: {
            MenuBarLabel(badge: model.store.badge)
        }
        .menuBarExtraStyle(.window)
        #endif

        Settings {
            SettingsView(
                preferences: model.preferences,
                tokens: model.tokens,
                loginItem: model.loginItem,
                onTokensChanged: { model.store.reconfigure() })
        }
    }
}

/// Builds `PopoverActions` where the SwiftUI environment (`openSettings`) is available.
private struct PopoverHost: View {
    let model: AppModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        PopoverView(store: model.store, actions: model.actions(openSettings: {
            // An accessory app must activate first or the Settings window opens behind others.
            NSApp.activate()
            openSettings()
        }))
        .task {
            await model.store.refresh()
            await model.store.loadManagerHistory()
        }
    }
}

@MainActor
@Observable
final class AppModel {
    let preferences: PreferencesStore
    let tokens: any TokenStoring
    let loginItem: LoginItem
    let store: MenuBarStore
    @ObservationIgnored let opener: Opener
    @ObservationIgnored private let hotkey: HotkeyManager
    @ObservationIgnored private(set) var notifications: NotificationController?
    @ObservationIgnored private var lastPreferences: MenuBarPreferences
    @ObservationIgnored private var lastWidgetReload: Date = .distantPast
    @ObservationIgnored private var pendingWidgetReload: Task<Void, Never>?

    init() {
        #if DROVER_DEV
        // Dev build: its own defaults (its own bundle id), no App Group mirror, tokens from the daemon's state folder.
        let preferences = PreferencesStore(defaults: .standard, shared: nil)
        preferences.value.serverURL = DevEnvironment.serverURL
        let tokens: any TokenStoring = DevTokenStore()
        #else
        let preferences = PreferencesStore()
        let tokens: any TokenStoring = KeychainTokenStore()
        #endif
        self.preferences = preferences
        self.tokens = tokens
        self.loginItem = LoginItem()
        self.store = MenuBarStore(
            preferences: { preferences.value },
            tokens: tokens,
            transport: URLSessionTransport())
        self.opener = Opener(preferences: { preferences.value })
        self.hotkey = HotkeyManager(onPress: { PopoverToggler.toggle() })
        self.lastPreferences = preferences.value

        let opener = self.opener
        #if DROVER_DEV
        let notify = DevEnvironment.notifications
        #else
        let notify = true
        #endif
        let notifications = NotificationController(
            store: store,
            preferences: { preferences.value },
            open: { id, host in opener.openSession(id: id, host: host ?? "local") },
            openBoard: { opener.openDashboard() },
            enabled: notify)
        self.notifications = notifications

        preferences.onChange = { [weak self] new in self?.preferencesChanged(new) }
        #if !DROVER_DEV
        store.onSummaryFetched = { summary in Self.writeWidgetCache(summary) }
        store.onSummaryChanged = { [weak self] _ in self?.scheduleWidgetReload() }
        _ = hotkey.register(preferences.value.hotkey)
        #endif

        notifications.activate()
        store.start()
        #if DROVER_DEV
        DevHarness.start(self)
        #endif
    }

    func actions(openSettings: @escaping @MainActor () -> Void) -> PopoverActions {
        let opener = self.opener
        return PopoverActions(
            openWaiting: { opener.openSession(id: $0.id, host: $0.host, engine: $0.engine, name: $0.name) },
            openWorking: { opener.openSession(id: $0.id, host: $0.host, engine: $0.engine, name: $0.name) },
            openDashboard: { opener.openDashboard() },
            openManager: { opener.openManager() },
            openSettings: openSettings,
            quit: { NSApp.terminate(nil) })
    }

    private func preferencesChanged(_ new: MenuBarPreferences) {
        let old = lastPreferences
        lastPreferences = new
        #if !DROVER_DEV
        if new.hotkey != old.hotkey { _ = hotkey.register(new.hotkey) }
        #endif
        if new.serverURL != old.serverURL || new.pollSeconds != old.pollSeconds { store.reconfigure() }
    }

    /// CONTRACT.md widget handoff: bare summary at `<App Group>/summary.json` after every fetch (its
    /// modification date is the fetch time).
    private static func writeWidgetCache(_ summary: Summary) {
        guard let dir = SummaryCache.containerURL else { return }
        // Unsigned or unprovisioned builds have no App Group container; widgets just stay stale.
        try? SummaryCache.write(summary, to: dir)
    }

    /// Reload widgets when the content changed, at most once a minute (WidgetKit budgets reloads),
    /// with a trailing reload so the last change is never lost.
    private func scheduleWidgetReload() {
        let wait = 60 - Date().timeIntervalSince(lastWidgetReload)
        guard wait > 0 else {
            reloadWidgets()
            return
        }
        guard pendingWidgetReload == nil else { return }
        pendingWidgetReload = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            self?.reloadWidgets()
        }
    }

    private func reloadWidgets() {
        pendingWidgetReload?.cancel()
        pendingWidgetReload = nil
        lastWidgetReload = Date()
        WidgetCenter.shared.reloadAllTimelines()
    }
}
