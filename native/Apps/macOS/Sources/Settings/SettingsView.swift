import SwiftUI

/// Settings scene: Connection (server URL, tokens in Keychain), Notifications (rules, sounds, quiet hours),
/// Safari (the embedded extension's state), General.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        TabView {
            ConnectionSettingsView()
                .tabItem { Label("Connection", systemImage: "network") }
            NotificationSettingsView()
                .tabItem { Label("Notifications", systemImage: "bell") }
            SafariSettingsView()
                .tabItem { Label("Safari", systemImage: "safari") }
            GeneralSettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 540, height: 520)
    }
}

struct GeneralSettingsView: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        @Bindable var settings = model.settings
        Form {
            Toggle("Show hidden turns in chat (harness notes, queued messages, titles)", isOn: $settings.showToolTurns)
            Text("Tool calls always show, grouped under their results. Thinking is never shown.")
                .font(.caption).foregroundStyle(Theme.ink3)
        }
        .formStyle(.grouped)
    }
}
