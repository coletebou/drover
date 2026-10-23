import SwiftUI

struct PairingStatusView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false

    var body: some View {
        List {
            row("Server") {
                if model.baseURL == nil {
                    Text("Not set").foregroundStyle(Palette.ink3)
                } else {
                    Text(PairingFormatting.serverLabel(model.baseURL))
                        .font(Palette.mono(.footnote))
                        .foregroundStyle(Palette.ink)
                }
            }
            row("Replies") { presence(model.hasMainToken) }
            row("Updates") { presence(model.hasWidgetToken) }
            row("Last sync") {
                if let date = WatchSyncReceiver.shared.lastSyncAt {
                    Text(date, style: .relative).foregroundStyle(Palette.ink)
                } else {
                    Text("Never").foregroundStyle(Palette.ink3)
                }
            }
            Text("Open Drover on your iPhone to pair this watch. Tokens stay in the watch keychain.")
                .font(.footnote)
                .foregroundStyle(Palette.ink3)
            Button("Unpair this watch", role: .destructive) { confirmUnpair = true }
        }
        .navigationTitle("Pairing")
        .confirmationDialog("Remove the server and tokens from this watch?", isPresented: $confirmUnpair,
                            titleVisibility: .visible) {
            Button("Unpair", role: .destructive) { WatchSyncReceiver.shared.unpair() }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func row<Content: View>(_ title: String, @ViewBuilder _ value: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.footnote).foregroundStyle(Palette.ink2)
            value()
        }
    }

    private func presence(_ present: Bool) -> some View {
        Text(present ? "Paired" : "Not paired").foregroundStyle(present ? Palette.moss : Palette.ink3)
    }
}

#Preview {
    NavigationStack { PairingStatusView() }.environment(AppModel.preview())
}
