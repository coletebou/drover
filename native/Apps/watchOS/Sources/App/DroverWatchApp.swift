import SwiftUI

@main
struct DroverWatchApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let m = AppModel()
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
                .task { WatchSyncReceiver.shared.activate() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await NewWaitingNotifier.requestAuthorization()
                model.reloadFromCache()
                await model.refresh()
                await BackgroundRefresh.schedule()
            }
        }
        .backgroundTask(.appRefresh(BackgroundRefresh.taskID)) {
            await BackgroundRefresh.run()
        }
        .backgroundTask(.urlSession(BackgroundSummaryDownload.identifier)) {
            await BackgroundSummaryDownload.shared.handleEvents()
        }
        .backgroundTask(.watchConnectivity) {
            await WatchSyncReceiver.shared.handleBackgroundTask()
        }
    }
}
