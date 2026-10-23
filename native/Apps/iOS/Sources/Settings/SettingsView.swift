import DroverKit
import SwiftUI

/// Server address, tokens, status, manager host, notifications and feedback.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var minSize: CGFloat = 44

    @State private var address = ""
    @State private var mainToken = ""
    @State private var widgetToken = ""
    @State private var managerHost = ""
    @State private var muted: Set<String> = []
    @State private var haptics = true
    @State private var loaded = false
    @State private var removing: TokenVault.Account?
    @State private var isTesting = false
    @State private var testResult: SettingsConnectionTest.Outcome?
    @State private var saveError: String?
    @State private var saved = false
    @State private var notificationResult: String?
    // Mirrors of the Keychain state, refreshed on appear and after changes.
    @State private var hasMain = false
    @State private var hasWidget = false
    /// Pair with Mac: the daemon hands both tokens over once its owner approves the code on the Mac.
    @State private var pairing = PairingController()
    /// A pair link's address, filled in and waiting for a tap on Pair with Mac (PairLinkPolicy).
    @State private var linkAddress: URL?

    var body: some View {
        NavigationStack {
            Form {
                serverSection
                statusSection
                managerSection
                notificationsSection
                safariSection
                feedbackSection
                aboutSection
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Settings")
            .onAppear {
                load()
                consumePairLink()   // a pair link that switched to this tab
            }
            .onChange(of: model.pendingPairURL) { _, _ in consumePairLink() }
            .onChange(of: pairing.phase) { _, phase in announce(phase) }
            .confirmationDialog("Remove this token?", isPresented: removeBinding, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { remove() }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    /// The link's address while the field still shows it and no pairing runs.
    private var pendingLink: URL? {
        guard let linkAddress, !pairing.phase.isActive, SharedSettings.normalizedURL(address) == linkAddress else { return nil }
        return linkAddress
    }

    private var removeBinding: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    // MARK: sections

    private var serverSection: some View {
        Section {
            adaptiveRow {
                TextField("http://100.x.y.z:7337", text: $address)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                    .accessibilityLabel("Server address")
                    .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
                Button(pairing.phase.isActive ? "Cancel" : "Pair with Mac", action: togglePairing)
                    .buttonStyle(.borderless)
                    .frame(minHeight: minSize)
                    .disabled(!pairing.phase.isActive && SharedSettings.normalizedURL(address) == nil)
                    .accessibilityLabel(pairing.phase.isActive ? "Cancel pairing" : "Pair with Mac at \(address)")
                    .accessibilityHint(pairing.phase.isActive ? "" : "Shows a code to approve on your Mac, then saves both tokens.")
            }
            if let link = pendingLink {
                Label(PairLinkPolicy.confirmation(for: link), systemImage: "link")
                    .font(.footnote).foregroundStyle(Theme.waiting)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if pairing.phase != .idle {
                PairingRows(phase: pairing.phase, server: pairing.serverURL)
            }
            tokenRow("Main token", text: $mainToken, exists: hasMain, account: .main)
            tokenRow("Widget token", text: $widgetToken, exists: hasWidget, account: .widget)
            Button { Task { await testConnection() } } label: {
                HStack {
                    Text("Test connection")
                    if isTesting { ProgressView().accessibilityLabel("Testing") }
                }
                .frame(minHeight: minSize, alignment: .leading)
            }
            .disabled(isTesting)
            if let testResult {
                Label(testResult.text, systemImage: testResult.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                    .font(.footnote)
                    .foregroundStyle(testResult.ok ? Theme.idle : Theme.error)
            }
            Button("Save and connect") { save() }
                .frame(minHeight: minSize, alignment: .leading)
            if let saveError {
                Label(saveError, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(Theme.error)
            } else if saved {
                Label("Saved", systemImage: "checkmark.circle.fill")
                    .font(.footnote).foregroundStyle(Theme.idle)
            }
        } header: {
            Text("Server")
        } footer: {
            Text("Pair with Mac gets both tokens for you: approve the code on the Mac that runs the daemon. To enter them by hand instead, the main token lives at ~/.local/state/drover/token and the read-only widget token at ~/.local/state/drover/widget-token on that Mac. Widgets and the watch complications use only the widget token.")
        }
    }

    /// Side by side normally, stacked at accessibility sizes so field and button never overflow.
    private func adaptiveRow<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                                                  : AnyLayout(HStackLayout(spacing: 8))
        return layout { content() }
    }

    private func tokenRow(_ title: String, text: Binding<String>, exists: Bool, account: TokenVault.Account) -> some View {
        adaptiveRow {
            SecureField(exists ? "Saved in Keychain" : title, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(title)
                .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            if exists {
                Button("Remove", role: .destructive) { removing = account }
                    .buttonStyle(.borderless)
                    .frame(minHeight: minSize)
                    .accessibilityLabel("Remove \(title.lowercased())")
            }
        }
    }

    private var statusSection: some View {
        Section("Status") {
            let c = connectionDisplay
            HStack {
                StateBadge(state: c.state, text: c.badge)
                Spacer()
            }
            if let detail = c.detail {
                Text(detail).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
        }
    }

    private var connectionDisplay: (state: BoardState, badge: String, detail: String?) {
        switch model.connection {
        case .online: (.idle, "Online", "Main token connected.")
        case .connecting: (.working, "Connecting", nil)
        case .readOnly: (.waiting, "Read-only", "Only the widget token is set. Add the main token to act on sessions.")
        case .failed(let m): (.error, "Failed", m)
        case .unconfigured: (.idle, "Not set up", "Enter the server address and a token.")
        }
    }

    private var managerSection: some View {
        Section {
            adaptiveRow {
                TextField("Find automatically", text: $managerHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(applyManagerHost)
                    .onChange(of: managerHost) { _, _ in applyManagerHost() }
                    .accessibilityLabel("Manager host")
                let names = model.summary?.hosts.map(\.name) ?? []
                if !names.isEmpty {
                    Menu {
                        Button("Find automatically") { managerHost = "" }
                        ForEach(names, id: \.self) { n in Button(n) { managerHost = n } }
                    } label: {
                        Image(systemName: "list.bullet").frame(minWidth: minSize, minHeight: minSize)
                    }
                    .accessibilityLabel("Pick a host")
                }
            }
        } header: {
            Text("Manager")
        } footer: {
            Text("Leave empty to use the host of the first OpenClaw session.")
        }
    }

    private var notificationsSection: some View {
        Section {
            Button("Allow notifications") {
                Task {
                    let ok = await NotificationManager.shared.requestAuthorization()
                    notificationResult = ok ? "Notifications allowed." : "Notifications are not allowed. You can change this in the Settings app."
                    A11y.announce(notificationResult ?? "")
                }
            }
            .frame(minHeight: minSize, alignment: .leading)
            if let notificationResult {
                Text(notificationResult).font(.footnote).foregroundStyle(Theme.textSecondary)
            }
            ForEach(SettingsNotificationKind.all) { kind in
                Toggle(kind.label, isOn: Binding(
                    get: { SettingsNotificationKind.isEnabled(kind.id, muted: muted) },
                    set: { on in
                        muted = SettingsNotificationKind.updated(muted, kind: kind.id, enabled: on)
                        model.settings.mutedNotificationKinds = muted
                    }))
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("There is no push server. iOS wakes the app in the background now and then (often every 15 minutes or less often) to check the daemon, so alerts can be late. Open the app for live updates.")
        }
    }

    /// The embedded Safari web extension (Extensions/safari). iOS has no API to read its on/off state, so this
    /// says where the switch is. The extension uses this app's server and token, and its alerts reply through here.
    private var safariSection: some View {
        Section {
            Text("Open the Settings app and tap Safari (on iOS 18 and later it is under Apps), then Extensions, and turn on Drover. Allow it on the sites you want.")
        } header: {
            Text("Safari extension")
        } footer: {
            Text("The extension uses the server and token set here. Reply and Open on its notifications come back to this app.")
        }
    }

    private var feedbackSection: some View {
        Section("Feedback") {
            Toggle("Haptics", isOn: Binding(get: { haptics }, set: { haptics = $0; model.settings.hapticsEnabled = $0 }))
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("Version", value: Self.versionText)
            Text("No analytics, no crash reports. The app talks only to your daemon.")
                .font(.footnote).foregroundStyle(Theme.textSecondary)
        }
    }

    private static var versionText: String {
        let info = Bundle.main.infoDictionary
        let v = info?["CFBundleShortVersionString"] as? String ?? "?"
        let b = info?["CFBundleVersion"] as? String
        return b.map { "\(v) (\($0))" } ?? v
    }

    // MARK: actions

    private func load() {
        refreshTokenFlags()
        guard !loaded else { return }
        loaded = true
        address = model.settings.baseURL?.absoluteString ?? ""
        managerHost = model.settings.managerHost ?? ""
        muted = model.settings.mutedNotificationKinds
        haptics = model.settings.hapticsEnabled
    }

    private func refreshTokenFlags() {
        hasMain = model.vault.has(.main)
        hasWidget = model.vault.has(.widget)
    }

    private func applyManagerHost() {
        let t = managerHost.trimmingCharacters(in: .whitespacesAndNewlines)
        model.settings.managerHost = t.isEmpty ? nil : t
    }

    private func testConnection() async {
        testResult = nil
        guard let url = SharedSettings.normalizedURL(address.isEmpty ? (model.settings.baseURL?.absoluteString ?? "") : address) else {
            testResult = .init(ok: false, text: "Enter a valid http or https address.")
            announceTestResult()
            return
        }
        let vault = model.vault
        let typedMain = mainToken, typedWidget = widgetToken
        let token = [typedMain, typedWidget, vault.read(.main) ?? "", vault.read(.widget) ?? ""].first { !$0.isEmpty }
        guard let token else {
            testResult = .init(ok: false, text: "Enter a token first.")
            announceTestResult()
            return
        }
        isTesting = true
        defer { isTesting = false; announceTestResult() }
        let api = HTTPDroverAPI(baseURL: url, token: { token })
        do {
            let summary = try await api.summary()
            do {
                _ = try await api.sessions(host: nil)
                testResult = SettingsConnectionTest.outcome(hostCount: summary.hosts.count, sessionsError: nil)
            } catch {
                testResult = SettingsConnectionTest.outcome(hostCount: summary.hosts.count, sessionsError: error)
            }
        } catch {
            testResult = SettingsConnectionTest.failure(error)
        }
    }

    private func announceTestResult() {
        guard let testResult else { return }
        A11y.announce("Connection test \(testResult.ok ? "succeeded" : "failed"). \(testResult.text)")
    }

    private func save() {
        saveError = nil
        saved = false
        // What the user saves by hand wins: an approval still on its way must not overwrite it (reset cancels it).
        pairing.reset()
        linkAddress = nil
        do {
            try apply(address: address,
                      mainToken: mainToken.isEmpty ? .keep : .store(mainToken),
                      widgetToken: widgetToken.isEmpty ? .keep : .store(widgetToken),
                      announcement: "Settings saved")
        } catch {
            saveError = error.localizedDescription
            Haptics.failure()
            A11y.announce("Settings not saved. \(error.localizedDescription)")
        }
    }

    /// Save and connect, and pairing: address and tokens (Keychain, App Group), reconnect, then the watch.
    private func apply(address: String, mainToken: TokenVault.Change, widgetToken: TokenVault.Change, announcement: String) throws {
        try model.configure(baseURL: address, mainToken: mainToken, widgetToken: widgetToken)
        self.mainToken = ""
        self.widgetToken = ""
        refreshTokenFlags()
        WatchTokenSync.shared.push()
        Haptics.success()
        saved = true
        A11y.announce(announcement)
    }

    // MARK: pairing

    private func togglePairing() {
        if pairing.phase.isActive {
            pairing.cancel()
        } else if let url = SharedSettings.normalizedURL(address) {
            startPairing(url)
        }
    }

    private func startPairing(_ url: URL) {
        linkAddress = nil
        saveError = nil
        saved = false
        address = url.absoluteString
        let device = UIDevice.current
        let client = device.userInterfaceIdiom == .pad ? "Drover for iPad" : "Drover for iPhone"
        pairing.start(baseURL: url, client: client, device: device.name) { tokens in
            // The approving daemon's address with both of its tokens; without a widget token from it, ours is deleted.
            try apply(address: url.absoluteString, mainToken: .store(tokens.main), widgetToken: PairingSave.widgetChange(tokens.widget),
                      announcement: "Paired with your Mac")
        }
    }

    /// A `drover://pair?url=` link. Pairing again with the daemon already set up starts at once; any other address
    /// (and every address on a fresh install) is filled in and waits for a tap on Pair with Mac (PairLinkPolicy).
    private func consumePairLink() {
        guard loaded, let url = model.pendingPairURL else { return }
        model.pendingPairURL = nil
        // The same link again (a second scan) keeps the code on screen instead of asking for a new one.
        if pairing.phase.isActive && pairing.serverURL == url { return }
        if PairLinkPolicy.startsAutomatically(link: url, configured: model.settings.baseURL) {
            startPairing(url)
        } else {
            pairing.reset()
            address = url.absoluteString
            linkAddress = url
            A11y.announce(PairLinkPolicy.confirmation(for: url))
        }
    }

    private func announce(_ phase: PairingPhase) {
        switch phase {
        case .waiting(let code, _): A11y.announce("Pairing code \(PairingCode.spoken(code)). Approve it on your Mac.")
        case .denied: Haptics.failure(); A11y.announce("Pairing was denied.")
        case .expired: Haptics.failure(); A11y.announce("The pairing code expired.")
        case .failed(let message): Haptics.failure(); A11y.announce("Pairing failed. \(message)")
        case .idle, .requesting, .paired: break   // paired: apply() announced it
        }
    }

    private func remove() {
        guard let account = removing else { return }
        removing = nil
        pairing.reset()   // like Save: a late approval must not bring the removed token back
        do {
            try model.configure(baseURL: address.isEmpty ? (model.settings.baseURL?.absoluteString ?? "") : address,
                                mainToken: account == .main ? .delete : .keep,
                                widgetToken: account == .widget ? .delete : .keep)
            refreshTokenFlags()
            WatchTokenSync.shared.push()
            saveError = nil
        } catch {
            saveError = error.localizedDescription
            Haptics.failure()
        }
    }
}

#Preview {
    SettingsView().environment(AppModel.preview())
}
