import AppKit
import SwiftUI

/// Transcript of `session` with the dialog answer card and ComposerView pinned at the bottom.
///
/// Live updates: the daemon follows the transcript while the chat is open (`POST /api/follow`) and `turn` events land
/// in the ChatModel; an incremental read closes the gap after the follow starts and runs on reconnect and lane
/// changes. A session the daemon cannot follow (remote, Codex, headless) is read every 4 s while it works, never while
/// it is idle.
struct ChatView: View {
    let session: SessionItem
    @Environment(AppModel.self) private var model

    var body: some View {
        let chat = model.chatModel(for: session)
        VStack(spacing: 0) {
            if let err = chat.error { errorBanner(err) }
            ChatTranscriptView(rows: chat.rows, working: session.isWorking && !session.answersWithKeys,
                               emptyText: emptyText(chat), resetKey: session.key,
                               earlier: chat.hasEarlier ? { loadEarlier(chat) } : nil, loadingEarlier: chat.isLoading)
                .environment(\.chatSessionWorking, session.isWorking)
            if model.showsAnswerCard(session) {
                DialogAnswerView(session: session, style: .card)
                    .padding(.horizontal, 12).padding(.bottom, 10)
            } else if session.lane == .waiting, session.answerMode == .reply || session.waitKind == .question {
                replyHint
            }
            Divider().overlay(Theme.line)
            ComposerView(session: session)
        }
        .background(Theme.bg)
        .task(id: session.key) { await run(chat) }
        .task(id: session.key) { await watchDialog() }
        .onChange(of: session.lane) { _, _ in
            let service = model.service, s = session
            Task { await chat.poll(service: service, session: s) }
        }
        .onChange(of: model.resyncTick) { _, _ in
            let service = model.service, s = session
            Task { await chat.poll(service: service, session: s) }
        }
        .onChange(of: model.settings.showToolTurns) { _, show in chat.showHidden = show }
    }

    private func run(_ chat: ChatModel) async {
        guard !session.windowOnly else { return }
        let service = model.service
        let s = session
        if chat.loaded { await chat.poll(service: service, session: s) } else { await chat.load(service: service, session: s) }
        model.follow(s, on: true)
        defer { model.follow(s, on: false) }
        // The follow starts at the transcript's size when it begins: read once more for what landed in between.
        try? await Task.sleep(for: .seconds(1.5))
        if Task.isCancelled { return }
        await chat.poll(service: service, session: s)
        var lastPoll = Date()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(4))
            if Task.isCancelled { return }
            let current = model.session(forKey: s.key) ?? s
            guard current.isWorking else { continue }
            let live = chat.liveAt.map { Date().timeIntervalSince($0) < 90 } ?? false
            // Followed and talking: turn events carry it, a read every 30 s is the safety net.
            if live && Date().timeIntervalSince(lastPoll) < 30 { continue }
            await chat.poll(service: model.service, session: current)
            lastPoll = Date()
        }
    }

    private func loadEarlier(_ chat: ChatModel) {
        let service = model.service, s = session
        Task { await chat.loadEarlier(service: service, session: s) }
    }

    /// While the session waits (or a card is up), read its pane every 2 s, so the card is always the dialog on screen:
    /// the next question of a multi-question ask, its review screen, or gone.
    private func watchDialog() async {
        guard session.tmuxTarget != nil else { return }
        while !Task.isCancelled {
            let current = model.session(forKey: session.key) ?? session
            if model.isMainWindowVisible, current.lane == .waiting || model.showsAnswerCard(current), model.answering[current.key] == nil {
                await model.readScreen(current)
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func emptyText(_ chat: ChatModel) -> String {
        if session.windowOnly {
            return "This agent runs in a tmux window without a session record, so there is no transcript. Use the Screen tab, or send to its pane below."
        }
        return chat.isLoading || !chat.loaded ? "Loading" : "No messages yet"
    }

    private var replyHint: some View {
        HStack(spacing: 8) {
            Image(systemName: "questionmark.bubble").foregroundStyle(Theme.amber).accessibilityHidden(true)
            Text("\(session.name) asked a question. Reply below.").font(.callout).foregroundStyle(Theme.ink2)
            Spacer()
            Button("Reply") { model.focusComposer() }.controlSize(.small)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Theme.wash(Theme.amber))
    }

    private func errorBanner(_ text: String) -> some View {
        Text(text)
            .font(.callout).foregroundStyle(Theme.brick)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Theme.wash(Theme.brick))
    }
}

/// The scrolling list of chat rows, shared by session chats and the manager. It follows new rows only while you are
/// at the bottom; scrolled up, it leaves you where you are and offers "Jump to latest".
struct ChatTranscriptView: View {
    let rows: ChatRows
    var working: Bool
    var workingLabel = "Working"
    var emptyText: String
    /// A new value (another session, another thread) scrolls to the bottom.
    var resetKey: String
    /// Older turns exist: a button at the top reads them.
    var earlier: (() -> Void)? = nil
    var loadingEarlier = false

    @State private var atBottom = true
    @State private var unseen = false
    private static let bottom = "chat-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if let earlier, !rows.items.isEmpty {
                        Button { earlier() } label: {
                            HStack(spacing: 6) {
                                if loadingEarlier { ProgressView().controlSize(.mini) }
                                Text("Show earlier messages")
                            }
                        }
                        .buttonStyle(.plain).font(.callout).foregroundStyle(Theme.steel)
                        .frame(maxWidth: .infinity)
                        .disabled(loadingEarlier)
                    }
                    ForEach(rows.items) { item in
                        ChatItemView(item: item, rows: rows, isLast: item.id == rows.items.last?.id).id(item.id)
                    }
                    if working && !rows.items.isEmpty { WorkingLine(label: workingLabel) }
                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .padding(16)
                .background(ScrollEdgeObserver { atBottom = $0; if $0 { unseen = false } })
            }
            .overlay {
                if rows.items.isEmpty {
                    Text(emptyText)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.ink4)
                        .padding(40)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if unseen && !atBottom {
                    Button { scrollToBottom(proxy, animated: true) } label: {
                        Label("Jump to latest", systemImage: "arrow.down")
                    }
                    .controlSize(.small)
                    .padding(12)
                }
            }
            .onChange(of: rows.items.last) { _, _ in follow(proxy) }
            .onChange(of: rows.items.count) { _, _ in follow(proxy) }
            .onChange(of: working) { _, _ in follow(proxy) }
            .onChange(of: resetKey) { _, _ in atBottom = true; unseen = false; scrollToBottom(proxy, animated: false) }
            .onAppear { scrollToBottom(proxy, animated: false) }
        }
    }

    private func follow(_ proxy: ScrollViewProxy) {
        if atBottom { scrollToBottom(proxy, animated: false) } else { unseen = true }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        // After this update's layout; again a moment later, once lazily sized rows have settled.
        Task { @MainActor in
            if animated { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(Self.bottom, anchor: .bottom) } }
            else { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            try? await Task.sleep(for: .milliseconds(120))
            proxy.scrollTo(Self.bottom, anchor: .bottom)
        }
    }
}

/// Reports whether the enclosing scroll view is scrolled to (near) the bottom, on every scroll. Content growing under
/// it does not count as scrolling away, which is what lets the chat keep following new rows. When the scroll view
/// gets shorter (an answer card appears, the window shrinks) while at the bottom, it stays at the bottom.
struct ScrollEdgeObserver: NSViewRepresentable {
    var onChange: (Bool) -> Void

    func makeNSView(context: Context) -> Probe { Probe(onChange: onChange) }
    func updateNSView(_ nsView: Probe, context: Context) { nsView.onChange = onChange }

    final class Probe: NSView {
        var onChange: (Bool) -> Void
        private weak var clip: NSClipView?
        private var tokens: [NSObjectProtocol] = []
        private var last: Bool?

        init(onChange: @escaping (Bool) -> Void) { self.onChange = onChange; super.init(frame: .zero) }
        required init?(coder: NSCoder) { nil }

        private func detach() {
            for t in tokens { NotificationCenter.default.removeObserver(t) }
            tokens = []
            clip = nil
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil { detach(); return }
            guard let scroll = enclosingScrollView, scroll.contentView !== clip else { return }
            detach()
            let clipView = scroll.contentView
            clip = clipView
            clipView.postsBoundsChangedNotifications = true
            clipView.postsFrameChangedNotifications = true
            tokens.append(NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clipView,
                                                                 queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.report() }
            })
            tokens.append(NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: clipView,
                                                                 queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.keepBottom() }
            })
        }

        private func distanceToBottom() -> CGFloat? {
            guard let scroll = enclosingScrollView, let doc = scroll.documentView else { return nil }
            let bounds = scroll.contentView.bounds
            return doc.isFlipped ? doc.frame.height - bounds.maxY : bounds.minY
        }

        private func report() {
            guard let distance = distanceToBottom() else { return }
            let atBottom = distance < 60
            guard atBottom != last else { return }
            last = atBottom
            onChange(atBottom)
        }

        /// The visible area changed size: if it was at the bottom, put it back there.
        private func keepBottom() {
            guard last != false, let scroll = enclosingScrollView, let doc = scroll.documentView else { return }
            let clipView = scroll.contentView
            let y = doc.isFlipped ? max(0, doc.frame.height - clipView.bounds.height) : 0
            clipView.scroll(to: NSPoint(x: clipView.bounds.minX, y: y))
            scroll.reflectScrolledClipView(clipView)
        }
    }
}
