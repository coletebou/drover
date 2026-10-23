import SwiftUI

struct SettingsView: View {
    @Bindable var preferences: PreferencesStore
    let tokens: any TokenStoring
    let loginItem: LoginItem
    let onTokensChanged: @MainActor () -> Void

    init(preferences: PreferencesStore, tokens: any TokenStoring, loginItem: LoginItem,
         onTokensChanged: @escaping @MainActor () -> Void) {
        self.preferences = preferences
        self.tokens = tokens
        self.loginItem = loginItem
        self.onTokensChanged = onTokensChanged
    }

    var body: some View {
        TabView {
            ServerSettingsTab(preferences: preferences, tokens: tokens, onTokensChanged: onTokensChanged)
                .tabItem { Label("Server", systemImage: "server.rack") }
            GeneralSettingsTab(preferences: preferences, loginItem: loginItem)
                .tabItem { Label("General", systemImage: "gearshape") }
            NotificationSettingsTab(preferences: preferences)
                .tabItem { Label("Notifications", systemImage: "bell") }
        }
        .frame(width: 460)
    }
}

// MARK: - Server

private struct ServerSettingsTab: View {
    @Bindable var preferences: PreferencesStore
    let tokens: any TokenStoring
    let onTokensChanged: @MainActor () -> Void
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var draftIsValid: Bool { MenuBarPreferences(serverURL: draft).baseURL != nil }
    private var draftChanged: Bool { draft != preferences.value.serverURL }

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server address", text: $draft)
                    .focused($focused)
                    .onSubmit(apply)
                    .onChange(of: focused) { _, now in if !now { apply() } }
                    .accessibilityLabel("Server address")
                if !draftIsValid {
                    Text("Enter an https address, or http for localhost, an IP address or a .local name.")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                HStack {
                    Spacer()
                    Button("Apply", action: apply)
                        .disabled(!draftIsValid || !draftChanged)
                        .accessibilityLabel("Apply server address")
                }
            }
            Section("Tokens") {
                TokenRow(kind: .main, title: "Main token",
                         help: "Full access: replies, quick actions and live updates.",
                         tokens: tokens, onTokensChanged: onTokensChanged)
                TokenRow(kind: .widget, title: "Widget token",
                         help: "Read-only: counts and waiting list. Used for polling.",
                         tokens: tokens, onTokensChanged: onTokensChanged)
                Text("Find the tokens in the daemon's state folder: token and widget-token.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { draft = preferences.value.serverURL }
    }

    private func apply() {
        guard draftIsValid, draftChanged else { return }
        preferences.value.serverURL = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = preferences.value.serverURL
    }
}

private struct TokenRow: View {
    let kind: TokenKind
    let title: String
    let help: String
    let tokens: any TokenStoring
    let onTokensChanged: @MainActor () -> Void

    @State private var input = ""
    @State private var isSet = false
    @State private var error: String?
    @State private var confirmRemove = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                Spacer()
                Text(isSet ? "Saved" : "Not set")
                    .foregroundStyle(isSet ? Color.green : Color.secondary)
                    .accessibilityLabel("\(title) \(isSet ? "saved" : "not set")")
            }
            HStack {
                SecureField(title, text: $input, prompt: Text(isSet ? "Paste a new token" : "Paste a token"))
                    .labelsHidden()
                    .onSubmit(save)
                    .accessibilityLabel("\(title) field")
                Button("Save", action: save)
                    .disabled(input.isEmpty)
                    .accessibilityLabel("Save \(title)")
                Button("Remove") { confirmRemove = true }
                    .disabled(!isSet)
                    .accessibilityLabel("Remove \(title)")
            }
            Text(help).font(.caption).foregroundStyle(.secondary)
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .onAppear { isSet = tokens.token(kind) != nil }
        .confirmationDialog("Remove the \(title.lowercased())?", isPresented: $confirmRemove) {
            Button("Remove", role: .destructive, action: remove)
            Button("Cancel", role: .cancel) {}
        }
    }

    private func save() {
        guard KeychainTokenStore.looksLikeToken(input) else {
            error = "That does not look like a token. Paste it again without spaces."
            return
        }
        do {
            try tokens.setToken(input, for: kind)
            input = ""
            error = nil
            isSet = tokens.token(kind) != nil
            onTokensChanged()
        } catch {
            self.error = "Could not save the token."
        }
    }

    private func remove() {
        do {
            try tokens.setToken(nil, for: kind)
            error = nil
            isSet = tokens.token(kind) != nil
            onTokensChanged()
        } catch {
            self.error = "Could not remove the token."
        }
    }
}

// MARK: - General

private struct GeneralSettingsTab: View {
    @Bindable var preferences: PreferencesStore
    let loginItem: LoginItem

    var body: some View {
        Form {
            Section {
                Toggle("Open at login", isOn: Binding(
                    get: { loginItem.isEnabled },
                    set: { loginItem.setEnabled($0) }))
                    .accessibilityLabel("Open at login")
                Text(loginItem.statusText).font(.caption).foregroundStyle(.secondary)
                if loginItem.needsApproval {
                    Button("Open Login Items") { loginItem.openSystemSettings() }
                        .accessibilityLabel("Open Login Items in System Settings")
                }
                if let error = loginItem.lastError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            Section {
                Stepper("Check every \(preferences.value.pollSeconds) s",
                        value: $preferences.value.pollSeconds,
                        in: MenuBarPreferences.pollRange, step: 15)
                    .accessibilityLabel("Check every \(preferences.value.pollSeconds) seconds")
                Picker("Open sessions in", selection: $preferences.value.openTarget) {
                    Text("The Drover app, else the web UI").tag(OpenTarget.mainAppThenWeb)
                    Text("The web UI").tag(OpenTarget.webUI)
                }
                .accessibilityLabel("Open sessions in")
                LabeledContent("Global shortcut") {
                    HotkeyRecorder(combo: $preferences.value.hotkey)
                }
                .accessibilityLabel("Global shortcut")
            }
        }
        .formStyle(.grouped)
        .onAppear { loginItem.refresh() }
    }
}

// MARK: - Notifications

private struct NotificationSettingsTab: View {
    @Bindable var preferences: PreferencesStore

    var body: some View {
        Form {
            Section {
                Toggle("Notify when a session is waiting on you", isOn: $preferences.value.notifyOnWaiting)
                    .accessibilityLabel("Notify when a session is waiting on you")
                Toggle("Play a sound", isOn: $preferences.value.notificationSound)
                    .disabled(!preferences.value.notifyOnWaiting)
                    .accessibilityLabel("Play a sound")
                Text("Mute 1h in the menu also silences these.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

#Preview {
    SettingsView(
        preferences: PreferencesStore(defaults: UserDefaults(suiteName: "preview")!, shared: nil),
        tokens: StaticTokens([:]),
        loginItem: LoginItem(),
        onTokensChanged: {})
}
