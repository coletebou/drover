import DroverKit
import SwiftUI

/// Rows under the server address while pairing with the Mac (DroverKit `PairingController`): the code to approve
/// and how it went. Nothing while idle.
struct PairingRows: View {
    let phase: PairingPhase
    /// The daemon being paired with.
    let server: URL?

    var body: some View {
        switch phase {
        case .idle:
            EmptyView()
        case .requesting:
            HStack(spacing: 8) {
                ProgressView()
                Text("Asking \(serverName) for a code...")
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
            }
            .accessibilityElement(children: .combine)
        case .waiting(let code, let expiresAt):
            VStack(alignment: .leading, spacing: 6) {
                Text(PairingCode.formatted(code))
                    .font(Theme.mono(.largeTitle).weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                    .accessibilityLabel("Pairing code \(PairingCode.spoken(code))")
                Text((try? AttributedString(markdown: PairingCode.instructions(code))) ?? AttributedString(PairingCode.instructions(code)))
                    .font(.footnote).foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                let now = Date.now
                HStack(spacing: 4) {
                    Text("\(serverName), expires in")
                    Text(timerInterval: now...max(now, expiresAt), countsDown: true).monospacedDigit()
                }
                .font(.footnote).foregroundStyle(Theme.textSecondary)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        case .paired:
            outcome("Paired. Both tokens are saved on this device.", symbol: "checkmark.circle.fill", color: Theme.idle)
        case .denied:
            outcome("The request was denied on the Mac.", symbol: "xmark.octagon.fill", color: Theme.error)
        case .expired:
            outcome("The code expired. Tap Pair with Mac for a new one.", symbol: "clock.badge.exclamationmark", color: Theme.error)
        case .failed(let message):
            outcome(message, symbol: "exclamationmark.triangle.fill", color: Theme.error)
        }
    }

    private func outcome(_ text: String, symbol: String, color: Color) -> some View {
        Label(text, systemImage: symbol)
            .font(.footnote).foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// host:port of the daemon, as typed in the address field.
    private var serverName: String {
        guard let server, let host = server.host() else { return "the daemon" }
        return server.port.map { "\(host):\($0)" } ?? host
    }
}
