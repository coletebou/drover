import SwiftUI

/// Mute and Dashboard. Sweep lives in the manager box, next to the manager it asks.
struct QuickActions: View {
    let store: MenuBarStore
    let actions: PopoverActions

    @State private var message: String?
    @State private var messageIsError = false
    @State private var busy = false
    @State private var messageToken = 0

    private var mutedUntil: Date? {
        if let d = store.mutedUntil, d > Date() { return d }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if let until = mutedUntil {
                    Button {} label: {
                        Label("Muted until \(until.formatted(date: .omitted, time: .shortened))",
                              systemImage: "bell.slash.fill")
                    }
                    .disabled(true)
                } else {
                    Button { run("Alerts muted for 1 hour") { try await store.muteAlerts(minutes: 60) } } label: {
                        Label("Mute 1h", systemImage: "bell.slash")
                    }
                    .disabled(!store.canAct || busy)
                    .help(store.canAct ? "Mute alerts for one hour." : "Add the main token in Settings.")
                }

                Button { actions.openDashboard() } label: {
                    Label("Dashboard", systemImage: "rectangle.grid.2x2")
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)

            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(messageIsError ? Theme.error : Theme.idle)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }

    @MainActor
    private func run(_ success: String, _ work: @escaping @MainActor () async throws -> Void) {
        busy = true
        Task {
            do {
                try await work()
                show(success, isError: false)
            } catch {
                show((error as? DroverError)?.userMessage ?? "That did not work.", isError: true)
            }
            busy = false
        }
    }

    @MainActor
    private func show(_ text: String, isError: Bool) {
        messageToken += 1
        let token = messageToken
        message = text
        messageIsError = isError
        Task {
            try? await Task.sleep(for: .seconds(3))
            if token == messageToken { message = nil }
        }
    }
}
