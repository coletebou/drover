import Foundation
import Observation

/// What a waiting row shows about a key it pressed: in flight, then the outcome for a few seconds.
struct RowAnswerState: Sendable, Equatable {
    /// The key being sent.
    var pressing: String?
    var message: String?
    var isError = false
    /// The screen hash a key went to: the row keeps its buttons hidden until the dialog changes, so a summary
    /// that has not caught up yet cannot invite a second press on the same dialog.
    var answeredHash: String?
    var at: Date
}

/// The menu bar's single source of truth: polls `native.summary` with the widget token and, when the main
/// token is present, holds SSE (`/api/stream?topics=summary,alerts,manager,turn`). A `summary` event is the
/// board itself, applied as is (no re-fetch); the poll stays as the fallback while the stream is down or
/// quiet. `manager` and `turn` events stream the manager's reply into `manager`.
@MainActor
@Observable
final class MenuBarStore {
    private(set) var summary: Summary?
    private(set) var connection: ConnectionState = .unconfigured
    private(set) var lastUpdated: Date?
    private(set) var lastError: DroverError?
    /// Set by a successful `muteAlerts`; local notifications are suppressed until then.
    private(set) var mutedUntil: Date?

    var badge: BadgeState { BadgeState(summary: summary, connection: connection) }

    /// True when the main token is present, so replies and quick actions are allowed. Cached (read
    /// at init, `start()` and `reconfigure()`) so SwiftUI renders do not hit the Keychain.
    private(set) var canAct = false

    /// The last exchange with the manager, its reply streaming in.
    private(set) var manager = ManagerChat()
    /// False once the daemon answered "unknown op sessions.answer": rows then offer Open and Reply only.
    private(set) var answersSupported = true
    /// Per waiting item (`answerKey`): a key in flight or the outcome of the last press.
    private(set) var answerStates: [String: RowAnswerState] = [:]
    /// Approval requests being answered (request id -> the option pressed), so their buttons wait.
    private(set) var approvalPressing: [String: Int] = [:]
    /// What the last approval answer came to, above the waiting list for a few seconds: a decided or closed request
    /// leaves the list, so its row cannot say it.
    private(set) var approvalNotice: ApprovalNotice?
    /// Reviews of requests whose words may be shortened (request id -> the whole request, or how loading it went).
    private(set) var approvalReviews: [String: ApprovalReview] = [:]
    /// Requests answered here or closed elsewhere (id -> what the row says instead of its buttons), until the summary
    /// drops them: the daemon's board can lag an answer by seconds, and must not invite a second one meanwhile.
    private(set) var settledApprovals: [String: String] = [:]

    /// Waiting items that were not in the previous summary. Never fires for the first summary after
    /// `start()` or `reconfigure()` (that is a baseline, not news).
    @ObservationIgnored var onNewWaiting: (@MainActor ([WaitingItem]) -> Void)?

    /// New `native.notifications` items (oldest first). The first page after `start()` or
    /// `reconfigure()` only sets the cursor and does not fire. Long-polls with `wait`, widget token
    /// or main token, whichever is present (main preferred).
    @ObservationIgnored var onNotifications: (@MainActor ([NotificationItem]) -> Void)?

    /// Every summary whose content changed (ignoring `generatedAt`). Used to reload widgets.
    @ObservationIgnored var onSummaryChanged: (@MainActor (Summary) -> Void)?

    /// Every summary the app received, fetched or streamed, changed or not. Used to rewrite the widget
    /// cache, whose modification date is the fetch time (CONTRACT.md widget handoff).
    @ObservationIgnored var onSummaryFetched: (@MainActor (Summary) -> Void)?

    @ObservationIgnored private let preferences: @MainActor () -> MenuBarPreferences
    @ObservationIgnored private let tokens: any TokenProviding
    @ObservationIgnored private let transport: any HTTPTransport

    init(
        preferences: @escaping @MainActor () -> MenuBarPreferences,
        tokens: any TokenProviding,
        transport: any HTTPTransport
    ) {
        self.preferences = preferences
        self.tokens = tokens
        self.transport = transport
        self.canAct = tokens.token(.main) != nil
    }

    /// Sleep seam for the poll interval, debounce and backoff; tests replace it.
    @ObservationIgnored var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    /// How long a row keeps the outcome of a press on show.
    @ObservationIgnored var answerMessageSeconds: Double = 8
    /// How long the outcome of an approval answer stays above the waiting list.
    @ObservationIgnored var approvalNoticeSeconds: Double = 10
    /// How often a reply in flight is read from the transcript while no stream delivers it.
    @ObservationIgnored var managerCatchUpInterval: Duration = .seconds(2)

    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var catchUpTask: Task<Void, Never>?
    @ObservationIgnored private var hasBaseline = false
    @ObservationIgnored private var sseLive = false
    /// The daemon ignored `topics` (it sent an event the menu bar did not ask for): it predates the light
    /// events, so the old refresh-on-event rules apply.
    @ObservationIgnored private var legacyStream = false
    /// When the stream last delivered a summary or a manager event (nil: not on this connection).
    @ObservationIgnored private var lastStreamSummaryAt: Date?
    @ObservationIgnored private var lastManagerEventAt: Date?
    /// The daemon's own host name (SSE `hello`), so its manager events match a `local` manager.
    @ObservationIgnored private var frontHost: String?
    @ObservationIgnored private var managerHistoryLoaded = false
    /// The manager's host as `native.board` names it, looked up once per connection when the summary names none
    /// (`.some(nil)`: the daemon's own machine).
    @ObservationIgnored private var boardManagerHost: String??
    /// Bumped by every manager send, so a late answer only touches the send it belongs to.
    @ObservationIgnored private var managerSendSeq = 0
    @ObservationIgnored private var notificationCursor: String?
    @ObservationIgnored private var notificationsBaselined = false
    /// Bumped by `stop()`; results of requests started under an older generation are dropped, so a
    /// response from the previous server or token can never overwrite the current state.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var configuredBaseURL: URL?

    /// Events that mean "the board may have changed" on a daemon from before the light events.
    private static let refreshEvents: Set<String> = ["mutation", "notify", "alerts", "fleet", "snapshot"]
    private static let topicSet = Set(AppIdentifiers.streamTopics + ["hello"])

    /// True while the stream is up (not merely polling).
    var isLive: Bool { connection == .live }

    /// Begin polling (and SSE when the main token is present). Idempotent.
    func start() {
        guard tasks.isEmpty else { return }
        let hasMain = tokens.token(.main) != nil
        canAct = hasMain
        let base = preferences().baseURL
        if base != configuredBaseURL {
            // Another server: its sessions are not this one's, so do not show or act on them.
            summary = nil
            lastUpdated = nil
            lastError = nil
            mutedUntil = nil
            manager = ManagerChat()
            answerStates = [:]
            approvalPressing = [:]
            approvalNotice = nil
            approvalReviews = [:]
            settledApprovals = [:]
            answersSupported = true
            managerHistoryLoaded = false
            boardManagerHost = nil
            configuredBaseURL = base
        }
        guard base != nil, hasMain || tokens.token(.widget) != nil else {
            connection = .unconfigured
            return
        }
        connection = .connecting
        tasks.append(Task { [weak self] in await self?.pollLoop() })
        if hasMain { tasks.append(Task { [weak self] in await self?.streamLoop() }) }
        tasks.append(Task { [weak self] in await self?.notificationsLoop() })
    }

    /// Cancel polling and SSE.
    func stop() {
        generation += 1
        tasks.forEach { $0.cancel() }
        tasks = []
        debounceTask?.cancel()
        debounceTask = nil
        catchUpTask?.cancel()
        catchUpTask = nil
        sseLive = false
        legacyStream = false
        lastStreamSummaryAt = nil
        lastManagerEventAt = nil
    }

    /// Preferences or tokens changed: tear down and start again with a fresh baseline.
    func reconfigure() {
        stop()
        hasBaseline = false
        notificationCursor = nil
        notificationsBaselined = false
        start()
    }

    /// Fetch `native.summary` now (popover opened, user pressed refresh).
    func refresh() async {
        guard isConfigured else {
            connection = .unconfigured
            return
        }
        let gen = generation
        do {
            let client = try makeClient()
            let kind: TokenKind = client.tokens.token(.widget) != nil ? .widget : .main
            let s = try await client.summary(token: kind)
            guard !Task.isCancelled, gen == generation else { return }
            apply(s)
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, gen == generation else { return }
            fail(DroverError.from(error))
        }
    }

    /// `sessions.message {id, text, actor, host}` with the main token, then refresh.
    func reply(to item: WaitingItem, text: String) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let client = try mainClient()
        try await client.sendMessage(id: item.id, host: item.host, text: trimmed)
        await refresh()
    }

    /// `openclaw.sweep {}` with the main token, on the manager's host.
    func sweepManager() async throws {
        let client = try mainClient()
        let gen = generation
        let host = await managerHost(client)
        // The server or token changed while the host was looked up: the sweep was meant for the old one.
        guard gen == generation else { throw DroverError.transport("The server changed. Try again.") }
        try await client.sweep(host: host)
    }

    /// Who asked the manager question `q`; nil when it was the owner (the popover's "You"), by the generic actor or the
    /// name the latest summary gives.
    func asker(_ q: ManagerQuestion) -> String? {
        guard let who = q.askedBy, !AppIdentifiers.isOwner(who, owner: summary?.owner) else { return nil }
        return who
    }

    /// The `host` for manager ops: the summary's, else the board's (asked once per connection), else this machine.
    private func managerHost(_ client: DroverClient) async -> String? {
        if let host = summary?.manager?.opHost { return host }
        if let known = boardManagerHost { return known }
        let gen = generation
        let found = (try? await client.managerHost()) ?? nil
        if gen == generation { boardManagerHost = .some(found) }
        return found
    }

    /// `notify.mute {scope: "category", target, minutes, actor}` for each of `alertCategories`
    /// with the main token; on success sets `mutedUntil`.
    func muteAlerts(minutes: Int) async throws {
        let client = try mainClient()
        let gen = generation
        for category in Self.alertCategories {
            // The server or token changed mid-way: stop rather than finish against the old one.
            guard gen == generation else { throw CancellationError() }
            try await client.mute(category: category, minutes: minutes)
        }
        guard gen == generation else { return }
        mutedUntil = Date().addingTimeInterval(TimeInterval(minutes) * 60)
    }

    // MARK: Answers

    /// What the row for `item` offers: its keys, a reply box, or nothing (an older daemon).
    func answerPlan(for item: WaitingItem) -> AnswerPlan {
        guard answersSupported else { return item.answer == .reply ? .reply : .none }
        return AnswerModel.plan(for: item)
    }

    /// The press state to show on `item`'s row, if it is still current.
    func answerState(for item: WaitingItem, now: Date = Date()) -> RowAnswerState? {
        guard let st = answerStates[item.answerKey] else { return nil }
        if st.pressing != nil { return st }
        return now.timeIntervalSince(st.at) < answerMessageSeconds ? st : nil
    }

    /// True while the row should hold its buttons back: a key went to this very screen and the summary has not
    /// caught up with the answer yet.
    func isAwaitingScreen(_ item: WaitingItem, now: Date = Date()) -> Bool {
        guard let st = answerState(for: item, now: now), st.pressing == nil, !st.isError,
              let sent = st.answeredHash else { return false }
        return sent == item.hash
    }

    /// Press `key` on `item`'s dialog (a waiting row's button). Only keys the daemon listed are sent, with
    /// the screen hash the row showed; the outcome lands in `answerStates`.
    func answer(_ item: WaitingItem, key: String) async {
        let k = item.answerKey
        guard answerStates[k]?.pressing == nil else { return }
        guard answerPlan(for: item).buttons.contains(where: { $0.key == key }) else { return }
        answerStates[k] = RowAnswerState(pressing: key, at: Date())
        do {
            let outcome = try await answer(id: item.id, host: item.host, key: key, expect: item.hash)
            finishAnswer(k, message: outcome.message, isError: !outcome.isSent, answeredHash: outcome.isSent ? item.hash : nil)
        } catch is CancellationError {
            answerStates[k] = nil
        } catch {
            finishAnswer(k, message: DroverError.from(error).userMessage, isError: true, answeredHash: nil)
        }
    }

    /// `sessions.answer` (rows and notification actions). Sent: the summary refreshes shortly (the stream
    /// usually brings it first). Refused: shown as is, and the summary refreshes now so the row shows the
    /// screen as it is. "unknown op": the daemon predates the op.
    func answer(id: String, host: String, key: String, expect: String?) async throws -> AnswerOutcome {
        // Never a key without the screen hash it was offered for: it could land on another dialog.
        guard let expect, !expect.isEmpty else { return .refused(reason: "there is no screen hash to check the dialog against; open the session") }
        let client = try mainClient()
        let gen = generation
        do {
            let result = try await client.answer(id: id, host: host, key: key, expect: expect)
            let outcome = AnswerOutcome(result, key: key)
            guard gen == generation else { return outcome }
            if outcome.isSent { scheduleDebouncedRefresh(after: .milliseconds(1500)) } else { await refresh() }
            return outcome
        } catch let e as DroverError where e.isUnknownOp("sessions.answer") {
            if gen == generation { answersSupported = false }
            return .unsupported
        }
    }

    // MARK: Approvals

    /// What `item`'s row offers for its approval request: one click on words shown whole, else a review first.
    func approvalMode(for item: WaitingItem, now: Date = Date()) -> ApprovalRowMode? {
        guard let approval = item.approval else { return nil }
        if let settled = settledApprovals[approval.id] { return .closed(settled) }
        return ApprovalFormat.rowMode(summary: approval, review: approvalReviews[approval.id], host: item.host, canAct: canAct, now: now)
    }

    /// Load the whole request behind `item`'s row (`GET /api/approvals?id=`, main token) into `approvalReviews`.
    func reviewApproval(_ item: WaitingItem) async {
        guard let approval = item.approval, approvalReviews[approval.id] != .loading else { return }
        approvalReviews[approval.id] = .loading
        let gen = generation
        do {
            let client = try mainClient()
            let full = try await client.approval(id: approval.id)
            guard gen == generation else { return }
            approvalReviews[approval.id] = full.map(ApprovalReview.loaded) ?? .gone
        } catch is CancellationError {
            if gen == generation { approvalReviews[approval.id] = nil }
        } catch {
            guard gen == generation else { return }
            approvalReviews[approval.id] = .failed("Could not load the request: \(DroverError.from(error).userMessage)")
        }
    }

    /// Answer `item`'s approval request with option `choice` (a row's button): from the reviewed whole request when
    /// there is one, else from the row's own complete payload. The outcome lands in `approvalNotice`.
    func answerApproval(_ item: WaitingItem, choice: Int) async {
        guard case .answer(let approval)? = approvalMode(for: item), approvalPressing[approval.id] == nil,
              approval.options.contains(where: { $0.n == choice }) else { return }
        approvalPressing[approval.id] = choice
        let result: Result<ApprovalAnswerResult, Error>
        do {
            result = .success(try await answerApproval(id: approval.id, choice: choice))
        } catch is CancellationError {
            approvalPressing[approval.id] = nil
            return
        } catch {
            result = .failure(error)
        }
        approvalPressing[approval.id] = nil
        let o = ApprovalFormat.outcome(result, botName: item.botName)
        showApprovalNotice(o.text, isError: o.isError)
    }

    /// `POST /api/approvals/answer` with the main token (rows and notification actions), then a refresh: a decided or
    /// closed request leaves the list, or the bot's next request takes its place.
    func answerApproval(id: String, choice: Int) async throws -> ApprovalAnswerResult {
        let client = try mainClient()
        let gen = generation
        do {
            let result = try await client.answerApproval(id: id, choice: choice)
            if gen == generation {
                settledApprovals[id] = ApprovalFormat.settledText(result)
                await refresh()
            }
            return result
        } catch let e as DroverError {
            if gen == generation { await refresh() }
            throw e
        }
    }

    private func showApprovalNotice(_ text: String, isError: Bool) {
        let at = Date()
        approvalNotice = ApprovalNotice(text: text, isError: isError, at: at)
        let seconds = approvalNoticeSeconds
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard let self, self.approvalNotice?.at == at else { return }
            self.approvalNotice = nil
        }
    }

    func dismissApprovalNotice() { approvalNotice = nil }

    private func finishAnswer(_ key: String, message: String, isError: Bool, answeredHash: String?) {
        let at = Date()
        answerStates[key] = RowAnswerState(pressing: nil, message: message, isError: isError, answeredHash: answeredHash, at: at)
        let seconds = answerMessageSeconds
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            // Only this outcome: a newer press on the row keeps its own.
            guard let self, self.answerStates[key]?.at == at else { return }
            self.answerStates[key] = nil
        }
    }

    // MARK: Manager

    /// `sessions.message {id: "manager", text, wait: false}` on the manager's host. The reply streams in
    /// through `manager` events; without a stream the transcript is read until it lands.
    func askManager(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !manager.sending else { return }
        let client: DroverClient
        do { client = try mainClient() } catch {
            manager.beginSend(trimmed)
            manager.sendFailed(DroverError.from(error).userMessage)
            return
        }
        let gen = generation
        managerSendSeq += 1
        let seq = managerSendSeq
        manager.beginSend(trimmed)
        let host = await managerHost(client)
        // The server or token changed while the host was looked up: this message was typed for the old one and
        // its client still points there. It is not sent.
        guard gen == generation else {
            if isCurrentSend(seq) { manager.sendFailed("The server changed before the message went out. Ask again.") }
            return
        }
        do {
            let r = try await client.messageManager(trimmed, host: host)
            guard gen == generation else {
                // It went out, then the configuration changed. With the same server the reply still arrives (the
                // new connection's stream or a transcript read finds it); never leave the box stuck sending.
                if isCurrentSend(seq) { manager.sending = false }
                return
            }
            manager.sent(r)
            if manager.reply?.inFlight == true { startManagerCatchUp() }
        } catch is CancellationError {
            if isCurrentSend(seq) { manager.sendFailed("Cancelled.") }
        } catch {
            if isCurrentSend(seq) { manager.sendFailed(DroverError.from(error).userMessage) }
        }
    }

    /// The send `seq` is still the one on show (no reset by a server change, no newer send).
    private func isCurrentSend(_ seq: Int) -> Bool { seq == managerSendSeq && manager.sending }

    /// The last exchange from the manager's transcript, once per connection (the popover opened).
    func loadManagerHistory() async {
        guard canAct, !managerHistoryLoaded, manager.isEmpty, summary?.manager?.up == true else { return }
        managerHistoryLoaded = true
        let gen = generation
        guard let client = try? mainClient() else { return }
        let host = await managerHost(client)
        guard let page = try? await client.managerTranscript(host: host, limit: 12), gen == generation else { return }
        manager.seed(page.turns)
        if manager.reply?.inFlight == true { startManagerCatchUp() }
    }

    /// While a reply is due and the stream is not delivering it, read the transcript every couple of seconds
    /// (a pending reply carries the text so far). Stops when the reply settles, after 15 minutes, or on stop().
    private func startManagerCatchUp() {
        guard catchUpTask == nil else { return }
        let gen = generation
        catchUpTask = Task { [weak self] in
            let started = Date()
            while let self, !Task.isCancelled, gen == self.generation, self.manager.reply?.inFlight == true,
                  Date().timeIntervalSince(started) < 900 {
                do { try await self.sleep(self.managerCatchUpInterval) } catch { break }
                guard !Task.isCancelled, gen == self.generation, self.manager.reply?.inFlight == true else { break }
                if let at = self.lastManagerEventAt, Date().timeIntervalSince(at) < 5 { continue }
                guard let client = try? self.mainClient() else { continue }
                let host = await self.managerHost(client)
                guard let page = try? await client.managerTranscript(host: host, limit: 12), gen == self.generation else { continue }
                self.manager.catchUp(page.turns)
            }
            if let self, gen == self.generation { self.catchUpTask = nil }
        }
    }

    // MARK: Internals

    private var isConfigured: Bool {
        preferences().baseURL != nil && (tokens.token(.main) != nil || tokens.token(.widget) != nil)
    }

    /// A client bound to the current base URL and a snapshot of the current tokens, so a request
    /// sequence can never pair one server with another server's token.
    private func makeClient() throws -> DroverClient {
        guard let base = preferences().baseURL else { throw DroverError.notConfigured }
        var snapshot: [TokenKind: String] = [:]
        for kind in TokenKind.allCases { snapshot[kind] = tokens.token(kind) }
        return DroverClient(baseURL: base, tokens: StaticTokens(snapshot), transport: transport)
    }

    private func mainClient() throws -> DroverClient {
        guard tokens.token(.main) != nil else { throw DroverError.missingToken(.main) }
        return try makeClient()
    }

    private func apply(_ s: Summary) {
        let previous = summary
        var changed = true
        if var p = previous {
            p.generatedAt = s.generatedAt
            changed = p != s
        }
        var fresh: [WaitingItem] = []
        if hasBaseline {
            let known = Set(previous?.waiting.map(\.id) ?? [])
            fresh = s.waiting.filter { !known.contains($0.id) }
        }
        hasBaseline = true
        summary = s
        lastUpdated = Date()
        lastError = nil
        connection = sseLive ? .live : .polling
        pruneAnswerStates(s)
        onSummaryFetched?(s)
        if changed { onSummaryChanged?(s) }
        if !fresh.isEmpty { onNewWaiting?(fresh) }
    }

    /// Outcomes for rows that are gone, and stale ones, are dropped; so are reviews of requests no longer listed.
    private func pruneAnswerStates(_ s: Summary) {
        if !approvalReviews.isEmpty || !settledApprovals.isEmpty {
            let listed = Set(s.waiting.compactMap { $0.approval?.id })
            approvalReviews = approvalReviews.filter { listed.contains($0.key) || $0.value == .loading }
            settledApprovals = settledApprovals.filter { listed.contains($0.key) }
        }
        guard !answerStates.isEmpty else { return }
        let live = Set(s.waiting.map(\.answerKey))
        let now = Date()
        answerStates = answerStates.filter { key, st in
            st.pressing != nil || (live.contains(key) && now.timeIntervalSince(st.at) < answerMessageSeconds)
        }
    }

    private func fail(_ error: DroverError) {
        lastError = error
        if case .unauthorized = error {
            connection = .unauthorized
        } else {
            connection = .offline(error.userMessage)
        }
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            let interval = preferences().clampedPollSeconds
            // While the stream delivers summaries, a tick right after one would only fetch the same board.
            let streamed = sseLive && !legacyStream && lastStreamSummaryAt.map { Date().timeIntervalSince($0) < Double(interval) } == true
            if !streamed { await refresh() }
            do { try await sleep(.seconds(interval)) } catch { return }
        }
    }

    private func streamLoop() async {
        let transport = self.transport
        let sleep = self.sleep
        guard let client = try? makeClient() else { return }
        let stream = EventStream(makeRequest: { try client.streamRequest(topics: AppIdentifiers.streamTopics) },
                                 transport: transport, sleep: sleep)
        for await update in stream.updates() {
            if Task.isCancelled { return }
            switch update {
            case .connected:
                sseLive = true
                legacyStream = false
                lastStreamSummaryAt = nil
                connection = .live
                await refresh()
                // Whatever streamed while the connection was down is in the transcript.
                if manager.reply?.inFlight == true { startManagerCatchUp() }
            case .event(let event):
                handle(event)
            case .disconnected:
                sseLive = false
                lastStreamSummaryAt = nil
                // Only downgrade live to polling; keep offline or unauthorized until a fetch succeeds.
                if connection == .live { connection = .polling }
                if manager.reply?.inFlight == true { startManagerCatchUp() }
            }
        }
    }

    /// One SSE event. Exposed for tests (the stream calls it on the main actor).
    func handle(_ event: SSEEvent) {
        let data = Data(event.data.utf8)
        switch event.event {
        case "hello":
            struct Hello: Decodable { var host: String?; var topics: [String]? }
            let hello = try? JSONDecoder().decode(Hello.self, from: data)
            frontHost = hello?.host
            // A daemon that honours topics echoes them; one from before sends everything.
            if hello?.topics == nil { legacyStream = true }
        case "summary":
            guard let s = try? JSONDecoder().decode(Summary.self, from: data) else { return }
            lastStreamSummaryAt = Date()
            apply(s)
        case "manager":
            guard let e = try? JSONDecoder().decode(ManagerStreamEvent.self, from: data), isManagerHost(e.host) else { return }
            lastManagerEventAt = Date()
            manager.apply(e)
        case "turn":
            guard let e = try? JSONDecoder().decode(TurnEvent.self, from: data), e.id == AppIdentifiers.managerID,
                  isManagerHost(e.host) else { return }
            lastManagerEventAt = Date()
            var turn = e.turn
            if turn.thread == nil { turn.thread = e.thread }
            manager.apply(turn: turn)
        default:
            if !Self.topicSet.contains(event.event) { legacyStream = true }
            if legacyStream, Self.refreshEvents.contains(event.event) { scheduleDebouncedRefresh() }
        }
    }

    /// Manager events name their host; they count when it is the manager's (the daemon's own machine when the
    /// summary names none).
    private func isManagerHost(_ host: String?) -> Bool {
        guard let host, !host.isEmpty else { return true }
        let isFront = host == "local" || host == frontHost
        guard let want = summary?.manager?.opHost ?? boardManagerHost.flatMap({ $0 }) else { return isFront }
        return host == want || (isFront && want == frontHost)
    }

    private func scheduleDebouncedRefresh(after delay: Duration = .seconds(2)) {
        guard debounceTask == nil else { return }
        debounceTask = Task { [weak self] in
            guard let self else { return }
            do { try await self.sleep(delay) } catch { return }
            self.debounceTask = nil
            await self.refresh()
        }
    }

    private func notificationsLoop() async {
        let gen = generation
        var backoff = 5
        // Prefer the main token; fall back to the read-only widget token if the main one is rejected.
        var kind: TokenKind = tokens.token(.main) != nil ? .main : .widget
        while !Task.isCancelled, gen == generation {
            do {
                let client = try makeClient()
                if !notificationsBaselined {
                    // Baseline: no long-poll wait, just learn the current cursor.
                    let page = try await client.notifications(since: notificationCursor, wait: nil, limit: 50, token: kind)
                    guard !Task.isCancelled, gen == generation else { return }
                    notificationCursor = page.cursor
                    notificationsBaselined = true
                } else {
                    let page = try await client.notifications(since: notificationCursor, wait: 25, limit: 50, token: kind)
                    guard !Task.isCancelled, gen == generation else { return }
                    if let c = page.cursor { notificationCursor = c }
                    if !page.items.isEmpty { onNotifications?(page.items) }
                }
                backoff = 5
            } catch {
                if Task.isCancelled || error is CancellationError || gen != generation { return }
                if DroverError.from(error) == .unauthorized {
                    guard kind == .main, tokens.token(.widget) != nil else { return }
                    kind = .widget
                    continue
                }
                do { try await sleep(.seconds(backoff)) } catch { return }
                backoff = min(backoff * 2, 60)
            }
        }
    }

    /// The daemon's alert categories (ops-meta.js `notify.mute`).
    static let alertCategories = ["needs-you", "error", "held", "manager", "mr", "finished", "launch"]

    /// A store that never touches the network, for SwiftUI previews and tests.
    static func preview(
        _ summary: Summary? = .preview,
        connection: ConnectionState = .live,
        canAct: Bool = true,
        manager: ManagerChat = ManagerChat()
    ) -> MenuBarStore {
        let store = MenuBarStore(
            preferences: { .default },
            tokens: StaticTokens(canAct ? [.main: "preview"] : [.widget: "preview"]),
            transport: OfflineTransport())
        store.summary = summary
        store.connection = connection
        store.lastUpdated = summary == nil ? nil : Date()
        store.manager = manager
        return store
    }

    /// Previews and snapshots: a row's press outcome on show.
    func previewAnswerState(_ item: WaitingItem, _ state: RowAnswerState) {
        answerStates[item.answerKey] = state
    }
}

extension WaitingItem {
    /// Stable across summaries: one row per session per host.
    var answerKey: String { "\(host)\u{0}\(id)" }
}

/// A transport that always fails; previews never reach the network.
struct OfflineTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        throw DroverError.transport("Offline preview.")
    }
    func lines(for request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) {
        throw DroverError.transport("Offline preview.")
    }
}
