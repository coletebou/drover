import SwiftUI
import UserNotifications

struct NotificationSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var permission: String = "Checking"

    var body: some View {
        @Bindable var settings = model.settings
        Form {
            Section {
                Toggle("Show notifications", isOn: $settings.notificationRules.enabled)
                LabeledContent("System permission") {
                    HStack {
                        Text(permission).foregroundStyle(permission == "Allowed" ? Theme.moss : Theme.ink3)
                        Button("Open System Settings") {
                            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                    }
                }
            }
            Section("Categories") {
                ForEach(NotifyCategory.allCases) { category in
                    CategoryRow(category: category, rules: $settings.notificationRules)
                }
            }
            .disabled(!settings.notificationRules.enabled)
            Section("Quiet hours") {
                Toggle("Quiet hours", isOn: $settings.notificationRules.quietHours.enabled)
                Group {
                    DatePicker("From", selection: minutesBinding(\.startMinutes), displayedComponents: .hourAndMinute)
                    DatePicker("Until", selection: minutesBinding(\.endMinutes), displayedComponents: .hourAndMinute)
                    Toggle("Let needs-you alerts through", isOn: $settings.notificationRules.quietHours.needsYouBreaksThrough)
                }
                .disabled(!settings.notificationRules.quietHours.enabled)
            }
            Section {
                Button("Send test notification") { model.notifications.postTest() }
            }
        }
        .formStyle(.grouped)
        .task { await refreshPermission() }
    }

    private func minutesBinding(_ key: WritableKeyPath<NotificationRules.QuietHours, Int>) -> Binding<Date> {
        Binding(
            get: {
                let m = model.settings.notificationRules.quietHours[keyPath: key]
                return Calendar.current.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let p = Calendar.current.dateComponents([.hour, .minute], from: date)
                model.settings.notificationRules.quietHours[keyPath: key] = (p.hour ?? 0) * 60 + (p.minute ?? 0)
            }
        )
    }

    private func refreshPermission() async {
        guard Bundle.main.bundleIdentifier != nil else { permission = "Unavailable"; return }
        let s = await UNUserNotificationCenter.current().notificationSettings()
        switch s.authorizationStatus {
        case .authorized, .provisional, .ephemeral: permission = "Allowed"
        default: permission = "Not allowed"
        }
    }
}

private struct CategoryRow: View {
    var category: NotifyCategory
    @Binding var rules: NotificationRules

    var body: some View {
        let rule = rules.rule(for: category)
        HStack {
            Toggle(category.title, isOn: Binding(
                get: { rule.enabled },
                set: { var r = rule; r.enabled = $0; rules.setRule(r, for: category) }))
            Spacer()
            Picker("Sound", selection: Binding(
                get: { rule.sound ?? "None" },
                set: { var r = rule; r.sound = $0 == "None" ? nil : $0; rules.setRule(r, for: category) })) {
                Text("None").tag("None")
                ForEach(NotificationRules.systemSounds, id: \.self) { Text($0).tag($0) }
            }
            .labelsHidden()
            .frame(width: 130)
            .accessibilityLabel("\(category.title) sound")
            Button {
                NotificationSounds.play(rule.sound)
            } label: {
                Image(systemName: "speaker.wave.2")
            }
            .buttonStyle(.borderless)
            .disabled(rule.sound == nil)
            .accessibilityLabel("Play \(category.title) sound")
        }
    }
}
