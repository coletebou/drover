# Window 4: watchOS app (Apps/watchOS)
Companion watch app (SwiftUI, watchOS 10): glance list of Waiting items with headline, tap to see the last
message and send canned replies (yes, no, continue, go ahead, status?) or dictate; haptic on new waiting item via
background refresh (WKApplicationRefreshBackgroundTask) polling `native.summary` with the widget-scope token
only... replies need the main token: store it in the watch Keychain through WatchConnectivity transfer from the iOS app
(`WCSession.transferUserInfo`, token never in logs). Complication hooks are built by the widgets window; expose
shared data via the App Group-equivalent (watch uses its own container; document). Slices: list+detail, replies+dictation,
WatchConnectivity token/config sync, background refresh+haptics.
