# Window 3: iOS app (Apps/iOS)
SwiftUI, iOS 17+, iPhone first, iPad adaptive. Tabs: Board, Sessions, Manager (OpenClaw chat), Settings.
Session detail with chat, screen peek, key buttons row, voice dictation (on-device Speech only: set
`requiresOnDeviceRecognition`, otherwise disabled), share sheet / paste image attach (only if server upload op
exists), haptics. Background: BGAppRefreshTask + local notifications from `native.notifications` (no APNs: there is
no server push; say so in README), Live Activity for "waiting on you" is OUT of scope. Add an App Group + Keychain
group so widgets share the token and cache. Slices: board+sessions, chat+composer, manager+settings,
background refresh+notifications, accessibility (Dynamic Type, VoiceOver labels).
