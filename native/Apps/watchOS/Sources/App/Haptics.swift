import WatchKit

/// The only place the watch plays haptics.
enum Haptics {
    /// A session started waiting on you.
    @MainActor static func newWaiting() { WKInterfaceDevice.current().play(.notification) }
    /// A reply was delivered.
    @MainActor static func success() { WKInterfaceDevice.current().play(.success) }
    /// A reply or refresh failed.
    @MainActor static func failure() { WKInterfaceDevice.current().play(.failure) }
    /// Light tap feedback for a button press.
    @MainActor static func click() { WKInterfaceDevice.current().play(.click) }
}
