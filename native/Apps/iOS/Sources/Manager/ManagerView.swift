import SwiftUI

/// The OpenClaw fleet manager: status header, chat and feed.
struct ManagerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var minSize: CGFloat = 44

    private enum Mode: String, CaseIterable, Identifiable {
        case chat = "Chat", feed = "Feed"
        var id: String { rawValue }
    }

    @State private var mode: Mode = .chat
    @State private var status: ManagerStatus?
    @State private var statusError: String?
    @State private var messages: [ManagerMessage] = []
    @State private var chatError: String?
    @State private var feed: [ManagerFeedEvent] = []
    @State private var feedError: String?
    @State private var notFound = false
    @State private var loaded = false
    @State private var draft = ""
    @State private var sendError: String?
    @State private var isSending = false
    @State private var sendTask: Task<Void, Never>?
    @State private var confirmSweep = false
    @State private var notice: String?

    private var host: String? { ManagerHostResolver.resolve(setting: model.settings.managerHost, sessions: model.sessions) }
    private var canWrite: Bool { model.hasMainToken }
    private var managerRef: SessionRef { SessionRef(id: SessionRef.manager.id, host: host) }

    var body: some View {
        NavigationStack {
            Group {
                if notFound {
                    ContentUnavailableView("No manager found", systemImage: "person.crop.circle.badge.questionmark",
                                           description: Text("Set the manager host in Settings."))
                } else {
                    content
                }
            }
            .background(Theme.background)
            .navigationTitle("Manager")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Sweep now", systemImage: "wind") { confirmSweep = true }
                        .disabled(!canWrite || notFound)
                        .accessibilityLabel("Sweep now")
                        .accessibilityHint("Asks the manager to sweep the fleet now")
                }
            }
            .confirmationDialog("Ask the manager to sweep the fleet now?", isPresented: $confirmSweep, titleVisibility: .visible) {
                Button("Sweep now") { sweep() }
                Button("Cancel", role: .cancel) {}
            }
        }
        .task(id: host ?? "") { await reload() }
        .onDisappear { sendTask?.cancel() }
    }

    private var content: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ManagerStatusHeader(status: status, error: statusError)
                    Picker("View", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    if let notice {
                        Label(notice, systemImage: "checkmark.circle.fill")
                            .font(.footnote).foregroundStyle(Theme.idle)
                    }
                    if !canWrite {
                        Text("Read-only token: add the main token in Settings.")
                            .font(.footnote).foregroundStyle(Theme.textSecondary)
                    }
                    switch mode {
                    case .chat: chat
                    case .feed: feedList
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .refreshable { await reload() }
            .onChange(of: messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: isSending) { _, _ in scrollToBottom(proxy) }
            .safeAreaInset(edge: .bottom) { if mode == .chat { composer } }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if reduceMotion {
            proxy.scrollTo("bottom")
        } else {
            withAnimation { proxy.scrollTo("bottom") }
        }
    }

    // MARK: chat

    @ViewBuilder private var chat: some View {
        if let chatError {
            Text(chatError).font(.footnote).foregroundStyle(Theme.error)
        }
        if messages.isEmpty && !isSending && loaded {
            Text("No messages yet. Ask the manager about the fleet.")
                .font(.subheadline).foregroundStyle(Theme.textSecondary)
        }
        ForEach(messages) { ManagerBubble(message: $0) }
        if isSending {
            HStack(spacing: 8) {
                ProgressView()
                Text("The manager is thinking")
                    .font(.subheadline).foregroundStyle(Theme.textSecondary)
            }
            .accessibilityElement(children: .combine)
        }
        if let sendError {
            Label(sendError, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote).foregroundStyle(Theme.error)
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message the manager", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .padding(10)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.separator))
                .disabled(!canWrite)
            Button { send() } label: {
                Image(systemName: "arrow.up.circle.fill").font(.title)
                    .frame(minWidth: minSize, minHeight: minSize)
            }
            .keyboardShortcut(.return, modifiers: .command)
            .accessibilityLabel("Send")
            .accessibilityHint("Sends the message to the manager")
            .disabled(!canWrite || isSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: feed

    @ViewBuilder private var feedList: some View {
        if let feedError {
            Text(feedError).font(.footnote).foregroundStyle(Theme.error)
        } else if feed.isEmpty && loaded {
            Text("No recent manager events.").font(.subheadline).foregroundStyle(Theme.textSecondary)
        }
        ForEach(feed) { ManagerFeedRow(event: $0) }
    }

    // MARK: actions

    private func reload() async {
        let api = model.api
        let host = self.host
        async let st: Result<ManagerStatus, Error> = Self.capture { ManagerStatus.parse(try await api.managerStatus(host: host)) }
        async let tr: Result<[ManagerMessage], Error> = Self.capture {
            ManagerMessage.messages(from: try await Self.latestTurns(api: api, host: host, count: 200))
        }
        async let fd: Result<[ManagerFeedEvent], Error> = Self.capture { ManagerFeedEvent.parse(try await api.managerFeed(host: host, limit: 60)) }
        let (s, t, f) = await (st, tr, fd)
        guard !Task.isCancelled else { return }

        switch s {
        case .success(let v): status = v; statusError = nil
        case .failure(let e): statusError = e.localizedDescription
        }
        switch t {
        case .success(let v):
            // Keep an optimistic bubble that is still in flight.
            if !isSending { messages = v }
            chatError = nil
        case .failure(let e): chatError = e.localizedDescription
        }
        switch f {
        case .success(let v): feed = v; feedError = nil
        case .failure(let e): feedError = e.localizedDescription
        }
        let failures = [s.failureValue, t.failureValue, f.failureValue].compactMap { $0 }
        notFound = failures.count == 3 && failures.allSatisfy(ManagerHostResolver.isNotFound)
        loaded = true
    }

    /// The manager's transcript op pages forward from `since` (a turn index), so read the length first
    /// and then the last `count` turns; a plain `limit` would return the oldest turns once history grows.
    private static func latestTurns(api: any DroverAPI, host: String?, count: Int) async throws -> [Turn] {
        let ref = SessionRef(id: SessionRef.manager.id, host: host)
        let probe = try await api.transcript(ref, since: nil, limit: 1)
        let total = probe.offset ?? 0
        guard total > 1 else { return probe.turns }
        return try await api.transcript(ref, since: max(0, total - count), limit: count).turns
    }

    private static func capture<T: Sendable>(_ work: @Sendable () async throws -> T) async -> Result<T, Error> {
        do { return .success(try await work()) } catch { return .failure(error) }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        let bubble = ManagerMessage(id: "local-" + UUID().uuidString, isUser: true, text: text, date: Date())
        messages.append(bubble)
        draft = ""
        sendError = nil
        isSending = true
        let api = model.api
        let ref = managerRef
        sendTask = Task {
            // Runs on every exit, cancellation included, so the composer never stays disabled.
            defer { isSending = false; sendTask = nil }
            do {
                let result = try await api.message(ref, text: text)
                guard !Task.isCancelled else { return }
                let reply = (result.reply ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                messages.append(ManagerMessage(id: "local-" + UUID().uuidString, isUser: false,
                                               text: reply.isEmpty ? "The manager sent no reply." : reply, date: Date()))
                isSending = false
                Haptics.success()
                A11y.announce("Manager replied")
            } catch {
                guard !Task.isCancelled else { return }
                messages.removeAll { $0.id == bubble.id }
                if draft.isEmpty { draft = text }
                sendError = error.localizedDescription
                isSending = false
                Haptics.failure()
                A11y.announce("Message failed. \(error.localizedDescription)")
            }
        }
    }

    private func sweep() {
        let api = model.api
        let host = self.host
        Task {
            do {
                _ = try await api.managerSweep(host: host)
                Haptics.success()
                notice = "Sweep requested"
                A11y.announce("Sweep requested")
                try? await Task.sleep(for: .seconds(3))
                notice = nil
            } catch {
                Haptics.failure()
                notice = nil
                sendError = error.localizedDescription
                A11y.announce("Sweep failed. \(error.localizedDescription)")
            }
        }
    }
}

private extension Result {
    var failureValue: Failure? { if case .failure(let e) = self { e } else { nil } }
}

// MARK: pieces

private struct ManagerStatusHeader: View {
    let status: ManagerStatus?
    let error: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let status {
                let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: 8))
                layout {
                    if let up = status.isUp {
                        StateBadge(state: up ? .manager : .error, text: up ? "Manager up" : "Manager down")
                    }
                    if status.pausedByBudget == true {
                        StateBadge(state: .waiting, text: "Paused by budget")
                    }
                }
                if status.configured == false {
                    Text(status.reason ?? "The manager is not configured on this host.")
                        .font(.footnote).foregroundStyle(Theme.textSecondary)
                }
                line("Unit", status.unitState)
                line("Model", status.model)
                line("Thinking", status.thinking)
                line("Cost", status.costLine)
                line("Heartbeat", status.heartbeatEvery.map { "every \($0)" })
                line("Last activity", status.lastActivity?.relativeLabel)
                if !status.details.isEmpty {
                    DisclosureGroup("Details") {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(status.details) { d in
                                Text("\(d.key): \(d.value)").font(Theme.mono()).foregroundStyle(Theme.textSecondary)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .font(.subheadline)
                }
            } else if let error {
                Text(error).font(.footnote).foregroundStyle(Theme.error)
            } else {
                ProgressView().accessibilityLabel("Loading manager status")
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private func line(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            (Text(title + ": ").foregroundStyle(Theme.textSecondary) + Text(value).foregroundStyle(Theme.textPrimary))
                .font(.subheadline)
                .accessibilityElement(children: .combine)
        }
    }
}

private struct ManagerBubble: View {
    let message: ManagerMessage
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var gutter: CGFloat = 40

    var body: some View {
        HStack(spacing: 0) {
            if message.isUser { Spacer(minLength: typeSize.isAccessibilitySize ? 8 : gutter) }
            Text(message.attributed)
                .font(.body)
                .foregroundStyle(Theme.textPrimary)
                .padding(10)
                .background(message.isUser ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(message.isUser ? Theme.separator : Theme.manager.opacity(0.5)))
                .textSelection(.enabled)
            if !message.isUser { Spacer(minLength: typeSize.isAccessibilitySize ? 8 : gutter) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(message.isUser ? "You" : "Manager")\(message.date.map { ", \($0.relativeLabel)" } ?? ""): \(message.text)")
    }
}

private struct ManagerFeedRow: View {
    let event: ManagerFeedEvent
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            BoardAdaptiveStack(spacing: 8) {
                Text(event.type).font(.caption.weight(.semibold)).foregroundStyle(Theme.manager)
                if let a = event.actor { Text(a).font(.caption).foregroundStyle(Theme.textSecondary) }
                if !typeSize.isAccessibilitySize { Spacer() }
                if let d = event.date { Text(d.relativeLabel).font(.caption).foregroundStyle(Theme.textSecondary) }
            }
            if !event.text.isEmpty { Text(event.text).font(.subheadline).foregroundStyle(Theme.textPrimary) }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    ManagerView().environment(AppModel.preview())
}
