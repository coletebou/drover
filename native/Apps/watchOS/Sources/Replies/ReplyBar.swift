import SwiftUI

struct ReplyBar: View {
    let item: WaitingItem
    @Environment(AppModel.self) private var model
    @State private var flow = ReplyFlow()

    var body: some View {
        if !model.canReply {
            HStack(spacing: 6) {
                Image(systemName: "iphone")
                Text("Pair with iPhone to reply")
            }
            .font(.footnote)
            .foregroundStyle(Palette.ink3)
        } else {
            VStack(spacing: 8) {
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                    ForEach(CannedReply.allCases) { reply in
                        Button {
                            Haptics.click()
                            if let t = flow.tap(reply) { send(t) }
                        } label: {
                            Label(reply.label, systemImage: reply.symbol)
                                .font(.footnote)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                        .buttonStyle(.bordered)
                        .tint(tint(for: reply))
                        .accessibilityLabel(reply.accessibilityLabel)
                        .disabled(flow.isBusy)
                    }
                }

                TextFieldLink(prompt: Text("Reply to \(item.name)")) {
                    Label("Dictate", systemImage: "mic.fill")
                } onSubmit: {
                    flow.dictated($0)
                }
                .disabled(flow.isBusy)
                .accessibilityLabel("Dictate a reply")

                phaseView
            }
        }
    }

    private func tint(for reply: CannedReply) -> Color? {
        switch reply {
        case .yes, .goAhead, .proceed: return Palette.amber
        case .no, .status: return nil
        }
    }

    @ViewBuilder private var phaseView: some View {
        switch flow.phase {
        case .idle:
            EmptyView()
        case .confirming(let t):
            VStack(spacing: 6) {
                Text(t)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Palette.cardRaised, in: RoundedRectangle(cornerRadius: 10))
                Button("Send") {
                    if let t = flow.confirm() { send(t) }
                }
                .buttonStyle(.bordered)
                .tint(Palette.amber)
                Button("Cancel") { flow.cancel() }
                    .buttonStyle(.bordered)
            }
        case .sending:
            HStack(spacing: 6) {
                ProgressView()
                Text("Sending").font(.footnote).foregroundStyle(Palette.ink3)
            }
        case .sent(let t):
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.moss)
                Text("Sent: \(t)")
                    .font(.footnote)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
            }
        case .failed(_, let message):
            VStack(spacing: 6) {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Palette.brick)
                Button("Retry") {
                    if let t = flow.retry() { send(t) }
                }
                .buttonStyle(.bordered)
                .tint(Palette.amber)
                Button("Cancel") { flow.cancel() }
                    .buttonStyle(.bordered)
            }
        }
    }

    private func send(_ text: String) {
        Task {
            do {
                try await model.send(text, to: item)
                flow.succeeded()
                Haptics.success()
            } catch {
                flow.failed((error as? WatchClientError)?.message ?? "Send failed")
                Haptics.failure()
            }
        }
    }
}

#Preview("Can reply") {
    ScrollView { ReplyBar(item: PreviewData.summary.waiting[0]) }
        .environment(AppModel.preview())
}

#Preview("Not paired") {
    ScrollView { ReplyBar(item: PreviewData.summary.waiting[0]) }
        .environment(AppModel.preview(canReply: false))
}
