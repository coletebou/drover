import SwiftUI

struct ConnectionSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var test: TestState = .idle

    private enum TestState: Equatable {
        case idle, running, ok(String), failed(String)
    }

    var body: some View {
        @Bindable var settings = model.settings
        Form {
            Section("Server") {
                TextField("Server URL", text: $settings.serverURLString)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                if settings.serverURL == nil {
                    Text("Use an http or https URL, for example http://127.0.0.1:7337")
                        .font(.caption).foregroundStyle(Theme.brick)
                }
                LabeledContent("Status", value: model.connection.label)
            }
            Section("Pairing") {
                PairingStatus()
                HStack(spacing: 10) {
                    PairingButtons()
                    Spacer()
                }
                .font(.callout)
                Text("Asks the daemon at this URL for both tokens. Approve the code on the Mac that runs it, and the tokens go straight to your Keychain, with nothing to paste.")
                    .font(.caption).foregroundStyle(Theme.ink3)
            }
            Section("Token") {
                TokenField(title: "Token", store: model.tokens,
                           help: "The daemon keeps it in ~/.local/state/drover/token. It is stored only in your Keychain.",
                           revision: model.tokenRevision,
                           onChange: { model.applyConnectionSettings() })
            }
            Section("Widget token") {
                // Saving or removing a token by hand cancels a pairing in flight, so its approval cannot overwrite it.
                TokenField(title: "Widget token", store: model.widgetTokens,
                           help: "Read-only token for widgets (widget-token in the same folder). Widgets can read the board but cannot send messages.",
                           revision: model.tokenRevision,
                           onChange: { model.pairing.cancel() })
            }
            Section {
                HStack(spacing: 10) {
                    Button("Test connection") { runTest() }.disabled(test == .running || settings.serverURL == nil)
                    Button("Apply") { model.applyConnectionSettings() }
                    if test == .running { ProgressView().controlSize(.small) }
                    switch test {
                    case .ok(let host): Text("Connected to \(host)").foregroundStyle(Theme.moss)
                    case .failed(let msg): Text(msg).foregroundStyle(Theme.brick).lineLimit(2)
                    default: EmptyView()
                    }
                    Spacer()
                }
                .font(.callout)
            }
        }
        .formStyle(.grouped)
    }

    private func runTest() {
        test = .running
        let service = LiveDroverService(baseURL: model.settings.serverURL, tokens: model.tokens)
        Task {
            do {
                let host = try await service.ping()
                test = .ok(host)
            } catch {
                test = .failed(error.localizedDescription)
            }
        }
    }
}

/// Secure entry plus Keychain status. The value is never displayed or kept after saving.
struct TokenField: View {
    var title: String
    var store: TokenStore
    var help: String
    /// Changes when something else wrote the Keychain (pairing), so the status reads it again.
    var revision = 0
    var onChange: () -> Void
    @State private var entry = ""
    @State private var stored = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SecureField(title, text: $entry)
                .textFieldStyle(.roundedBorder)
                .onSubmit(save)
            HStack(spacing: 10) {
                Button("Save token", action: save)
                    .disabled(entry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Remove", action: remove).disabled(!stored)
                if let error {
                    Text(error).foregroundStyle(Theme.brick)
                } else if stored {
                    Text("Stored in Keychain").foregroundStyle(Theme.moss)
                } else {
                    Text("No token saved").foregroundStyle(Theme.ink3)
                }
            }
            .font(.callout)
            Text(help).font(.caption).foregroundStyle(Theme.ink3)
        }
        .onAppear { stored = store.read() != nil }
        .onChange(of: revision) {
            stored = store.read() != nil
            error = nil
        }
    }

    private func save() {
        let t = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        do {
            try store.write(t)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        entry = ""
        stored = store.read() != nil
        onChange()
    }

    private func remove() {
        do {
            try store.delete()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        stored = store.read() != nil
        onChange()
    }
}
