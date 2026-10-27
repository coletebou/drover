import SwiftUI

/// Chat transcript, tmux screen and composer for one session. Shown as the detail column of the
/// Board and Sessions split views, so it never creates its own navigation stack.
struct SessionDetailView: View {
    let ref: SessionRef
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var chat = ChatStore()
    @State private var screen = ScreenStore()
    @State private var mode: Mode = .chat

    enum Mode: String, CaseIterable, Identifiable {
        case chat = "Chat", screen = "Screen"
        var id: String { rawValue }
    }

    private var info: SessionInfo? { model.session(for: ref) }
    private var tmux: String? { info?.tmux }
    private var engine: Engine? { info?.engine }
    private var title: String { info?.title ?? String(ref.id.prefix(8)) }

    var body: some View {
        VStack(spacing: 0) {
            header
            approval
            if tmux != nil {
                Picker("View", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.bottom, 8)
            }
            content
        }
        .background(Theme.background)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if mode == .chat, screen.isDialog, let tmux {
                    VStack(alignment: .leading, spacing: 0) {
                        Label("A dialog is on screen", systemImage: BoardState.waiting.symbol)
                            .font(.caption.weight(.semibold)).foregroundStyle(Theme.waiting)
                            .padding(.horizontal).padding(.top, 6)
                        KeyButtonsRow(ref: ref, target: tmux, screen: screen)
                    }
                    .background(Theme.surface)
                }
                ComposerView(ref: ref, tmux: tmux, chat: chat, screen: screen)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    Task { await refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh")
                .accessibilityHint("Reloads the transcript and screen")
                ShareLink(item: ChatMerge.plainText(chat.turns)) {
                    Label("Share transcript", systemImage: "square.and.arrow.up")
                }
                .disabled(chat.turns.isEmpty)
                .accessibilityLabel("Share transcript")
            }
        }
        .task(id: ref) { await chatLoop() }
        .task(id: tmux) {
            if let tmux, mode == .chat {
                await screen.refresh(host: ref.hostArg, target: tmux, api: model.api)
            }
        }
        .onChange(of: tmux) { _, new in if new == nil { mode = .chat } }
    }

    @ViewBuilder
    private var content: some View {
        switch mode {
        case .chat: ChatView(store: chat)
        case .screen: ScreenPeekView(ref: ref, target: tmux, screen: screen)
        }
    }

    private var header: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                                                  : AnyLayout(HStackLayout(spacing: 8))
        return VStack(alignment: .leading, spacing: 6) {
            Text(title).font(Theme.title(.title2)).foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)
            layout {
                StateBadge(state: model.boardState(for: ref))
                Text(engine?.label ?? "Agent").font(.caption).foregroundStyle(Theme.textSecondary)
                MonoText(text: ref.displayHost)
            }
            if let cwd = info?.cwd, !cwd.isEmpty {
                MonoText(text: cwd)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal).padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }

    /// A Grok bot's pending approval request, answered here as on the board; the last answer's outcome stays after.
    @ViewBuilder
    private var approval: some View {
        if let item = model.approvalItem(for: ref), let request = item.approval {
            // One view per request: the bot's next request starts afresh, and a press on the last one's buttons ends with it.
            ApprovalCard(approval: request, botName: item.botName, host: item.host, more: item.moreApprovals ?? 0,
                         reviewsOnOpen: true)
                .id(request.id)
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal).padding(.bottom, 8)
        }
        if ref.id.hasPrefix("grok:"), let notice = model.approvalNotice {
            ApprovalNoticeView(notice: notice) { model.dismissApprovalNotice() }
                .padding(.horizontal).padding(.bottom, 8)
        }
    }

    private func refresh() async {
        await chat.load(ref: ref, api: model.api, engineHint: engine)
        if let tmux { await screen.refresh(host: ref.hostArg, target: tmux, api: model.api) }
    }

    /// Initial load, then poll every 4 s until the view goes away (the task is cancelled).
    private func chatLoop() async {
        await chat.load(ref: ref, api: model.api, engineHint: engine)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            if Task.isCancelled { break }
            await chat.poll(ref: ref, api: model.api, engineHint: engine)
        }
    }
}

#Preview {
    NavigationStack { SessionDetailView(ref: MockDroverAPI.sessionsFixture[0].ref) }
        .environment(AppModel.preview())
}
