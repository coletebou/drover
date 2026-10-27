import SwiftUI

struct SessionDetailView: View {
    let item: WaitingItem
    @Environment(AppModel.self) private var model

    private enum Load { case loading, loaded(LastReply?), failed(String) }
    @State private var load: Load = .loading

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text(item.name).font(Palette.title(.title3)).foregroundStyle(Palette.ink)
                Text(ListFormatting.kindLabel(item))
                    .font(.caption2)
                    .foregroundStyle(item.kind.tint)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(item.kind.tint.opacity(0.18), in: Capsule())
                Text("\(item.host ?? "local") · \(item.engine)")
                    .font(Palette.mono(.caption2)).foregroundStyle(Palette.ink3)
                if let approval = item.approval {
                    // A Grok bot's approval request: answered with its options, not with a reply to the bot.
                    // One view per request: the bot's next request starts afresh, and a press on the last one's buttons ends with it.
                    ApprovalBar(item: item, approval: approval).id(approval.id).padding(.top, 4)
                } else {
                    Text(item.headline).font(.body).foregroundStyle(Palette.ink)

                    Text("Last message").font(.caption).foregroundStyle(Palette.ink3).padding(.top, 6)
                    lastMessage

                    ReplyBar(item: item).padding(.top, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(item.name)
        .task(id: item.key) { if item.approval == nil { await loadReply() } }
    }

    @ViewBuilder private var lastMessage: some View {
        if !model.canReply {
            Text("Pair with iPhone to see the last message").font(.footnote).foregroundStyle(Palette.ink3)
        } else {
            switch load {
            case .loading:
                ProgressView()
            case .loaded(let reply):
                let text = ListFormatting.tail(reply?.text ?? "", max: 800)
                if text.isEmpty {
                    Text("No reply yet").font(.footnote).foregroundStyle(Palette.ink3)
                } else {
                    Text(text).font(.footnote).foregroundStyle(Palette.ink2)
                }
            case .failed(let msg):
                Text(msg).font(.footnote).foregroundStyle(Palette.brick)
            }
        }
    }

    private func loadReply() async {
        guard model.canReply else { return }
        load = .loading
        do {
            load = .loaded(try await model.lastReply(for: item))
        } catch is CancellationError {
            return
        } catch {
            load = .failed((error as? WatchClientError)?.message ?? "Could not load")
        }
    }
}

#Preview("Detail") {
    NavigationStack { SessionDetailView(item: PreviewData.summary.waiting[0]) }
        .environment(AppModel.preview())
}

#Preview("Detail, approval") {
    NavigationStack { SessionDetailView(item: PreviewData.approvalItem) }
        .environment(AppModel.preview())
}

#Preview("Detail, no main token") {
    NavigationStack { SessionDetailView(item: PreviewData.summary.waiting[0]) }
        .environment(AppModel.preview(canReply: false))
}
