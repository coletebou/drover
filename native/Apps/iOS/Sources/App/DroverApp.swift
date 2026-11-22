import SwiftUI

/// Registers the notification delegate before launch finishes (Apple requires it for cold-launch taps).
final class DroverAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { NotificationManager.shared.registerEarly() }
        return true
    }
}

@main
struct DroverApp: App {
    @UIApplicationDelegateAdaptor(DroverAppDelegate.self) private var appDelegate
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    /// `--mock` runs on synthetic data (MockDroverAPI) with no network, no Keychain access, no background refresh and
    /// no notification polling. `AppModel.mock(arguments:)` reads the screen arguments.
    private let mock: Bool

    init() {
        mock = CommandLine.arguments.contains("--mock")
        _model = State(initialValue: mock ? AppModel.mock(arguments: CommandLine.arguments) : AppModel())
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { model.handle(url: $0) }
                .task {
                    guard !mock else { return }
                    NotificationManager.shared.activate(model: model)
                    WatchTokenSync.shared.activate()
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                model.startLive()
                Task {
                    await model.refreshAll()
                    if !mock { await NotificationManager.shared.pollNow() }
                }
            case .background:
                model.stopLive()
                if !mock { BackgroundRefresh.schedule() }
            default:
                break
            }
        }
        .backgroundTask(.appRefresh(DroverIDs.refreshTaskID)) { [mock] in
            if !mock { await BackgroundRefresh.run() }
        }
    }
}

/// Four tabs, the workspaces every client shares: Agents (Lanes or List, picked at its top), Prompts, Manager,
/// Settings. On iPad each tab hosts its own split view, so the tab bar stays and the content adapts.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.tabBarSelection) {
            Group {
                if model.selectedTab == .sessions { SessionsView() } else { BoardView() }
            }
            .tabItem { Label("Agents", systemImage: "square.grid.2x2") }
            .badge(model.summary?.totals.waiting ?? 0)
            .tag(AppModel.Tab.board)
            PromptsView()
                .tabItem { Label("Prompts", systemImage: "text.bubble") }
                .tag(AppModel.Tab.prompts)
            ManagerView()
                .tabItem { Label("Manager", systemImage: "person.crop.circle.badge.checkmark") }
                .tag(AppModel.Tab.manager)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppModel.Tab.settings)
        }
        .tint(Theme.textPrimary)
    }
}

/// Lanes or List at the top of the Agents tab (the sidebar's navigation bar), bound to the tab it shows.
struct AgentsPicker: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Picker("Agents", selection: Binding(get: { model.selectedTab == .sessions ? AppModel.Tab.sessions : .board },
                                            set: { model.selectedTab = $0 })) {
            Text("Lanes").tag(AppModel.Tab.board)
            Text("List").tag(AppModel.Tab.sessions)
        }
        .pickerStyle(.segmented)
        .fixedSize()
        .accessibilityLabel("Agents view")
        .accessibilityHint("Lanes shows what waits on you and what works; List shows every session")
    }
}

#Preview {
    RootView().environment(AppModel.preview())
}
