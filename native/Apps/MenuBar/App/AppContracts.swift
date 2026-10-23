import Foundation

// App-target interfaces shared by the popover, settings and wiring.

/// What the popover can ask the app to do. Implemented in DroverMenuBarApp.swift.
struct PopoverActions {
    /// Open a waiting session (main app deep link or web UI, per preferences).
    var openWaiting: @MainActor (WaitingItem) -> Void
    var openWorking: @MainActor (WorkingItem) -> Void
    /// The board: main app, else the web UI.
    var openDashboard: @MainActor () -> Void
    /// The full manager: `drover://manager` in the main app, else the web UI's Manager view.
    var openManager: @MainActor () -> Void
    var openSettings: @MainActor () -> Void
    var quit: @MainActor () -> Void

    static let noop = PopoverActions(
        openWaiting: { _ in }, openWorking: { _ in }, openDashboard: {}, openManager: {}, openSettings: {}, quit: {})
}
