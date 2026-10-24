import SwiftUI

@main
struct DroverWatchApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    /// `--mock` runs on synthetic data (PreviewData) with no network, no Keychain access, no background refresh and no
    /// notification prompt. `AppModel.mock(arguments:)` reads the screen arguments.
    private let mock: Bool

    init() {
        mock = CommandLine.arguments.contains("--mock")
        let m = mock ? AppModel.mock(arguments: CommandLine.arguments) : AppModel()
        m.onNewWaiting = { _ in Haptics.newWaiting() }
        m.onSummaryCached = { Complications.reload() }
        _model = State(initialValue: m)
        WatchSyncReceiver.shared.attach(model: m)
        NotificationRouter.shared.install(model: m)
        BackgroundIngest.model = m
    }

    var body: some Scene {
        WindowGroup {
            WaitingListView()
                .environment(model)
                .onOpenURL { model.open($0) }
                .task { if !mock { WatchSyncReceiver.shared.activate() } }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, !mock else { return }
            Task {
                await NewWaitingNotifier.requestAuthorization()
                model.reloadFromCache()
                await model.refresh()
                await BackgroundRefresh.schedule()
            }
        }
        .backgroundTask(.appRefresh(BackgroundRefresh.taskID)) { [mock] in
            if !mock { await BackgroundRefresh.run() }
        }
        .backgroundTask(.urlSession(BackgroundSummaryDownload.identifier)) { [mock] in
            if !mock { await BackgroundSummaryDownload.shared.handleEvents() }
        }
        .backgroundTask(.watchConnectivity) {
            await WatchSyncReceiver.shared.handleBackgroundTask()
        }
    }
}
