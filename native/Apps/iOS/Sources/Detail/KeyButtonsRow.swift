import SwiftUI

/// Buttons that send single keys to the tmux pane, for answering dialogs from the phone.
struct KeyButtonsRow: View {
    let ref: SessionRef
    let target: String
    let screen: ScreenStore
    @Environment(AppModel.self) private var model
    @ScaledMetric(relativeTo: .body) private var minSize: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(PaneKey.allCases) { key in
                        Button {
                            Haptics.tap()
                            Task {
                                await screen.sendKey(key, host: ref.hostArg, target: target, api: model.api)
                                A11y.announce(screen.keyError ?? "Sent \(key.accessibilityLabel.lowercased())")
                            }
                        } label: {
                            Text(key.label)
                                .font(Theme.mono(.body))
                                .frame(minWidth: minSize, minHeight: minSize)
                                .padding(.horizontal, 6)
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(Theme.textPrimary)
                        .disabled(!model.hasMainToken)
                        .accessibilityLabel(key.accessibilityLabel)
                        .accessibilityHint("Sends this key to the terminal")
                        .accessibilityShowsLargeContentViewer()
                    }
                }
                .padding(.horizontal)
            }
            if let err = screen.keyError {
                Text(err).font(.footnote).foregroundStyle(Theme.error).padding(.horizontal)
            }
        }
        .padding(.vertical, 6)
    }
}
