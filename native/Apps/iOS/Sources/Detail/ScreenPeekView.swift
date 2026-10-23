import SwiftUI

struct ScreenPeekView: View {
    let ref: SessionRef
    let target: String?
    let screen: ScreenStore
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let target {
            VStack(spacing: 0) {
                statusLine
                ScrollView([.horizontal, .vertical]) {
                    Text(screen.capture?.text ?? (screen.error == nil ? "Loading screen" : ""))
                        .font(Theme.mono(.caption)).foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
                .background(Theme.surface)
                KeyButtonsRow(ref: ref, target: target, screen: screen)
            }
            .background(Theme.background)
            .task(id: target) {
                while !Task.isCancelled {
                    await screen.refresh(host: ref.hostArg, target: target, api: model.api)
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        } else {
            ContentUnavailableView("Not in tmux", systemImage: "rectangle.dashed",
                                   description: Text("This session has no tmux pane to show."))
        }
    }

    private var statusLine: some View {
        BoardAdaptiveStack(spacing: 8) {
            switch screen.state {
            case "dialog": StateBadge(state: .waiting, text: "A dialog is on screen")
            case "busy": StateBadge(state: .working, text: "Working")
            case "idle": StateBadge(state: .idle, text: "At the prompt")
            default: Text("Unknown").font(.caption.weight(.semibold)).foregroundStyle(Theme.textSecondary)
            }
            if let error = screen.error {
                Text(error).font(.caption).foregroundStyle(Theme.error)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal).padding(.vertical, 6)
    }
}
