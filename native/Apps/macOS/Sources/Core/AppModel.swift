import AppKit
import DroverKit
import Foundation
import Observation
import SwiftUI

/// What the sidebar filters the board by. `.manager` keeps the whole board and puts the manager in the detail column.
enum SidebarItem: Hashable, Sendable {
    case all
    case lane(Lane)
    case host(String)
    case manager
}

enum DetailTab: String, CaseIterable, Identifiable, Sendable {
    case chat, screen, info
    var id: String { rawValue }
    var title: String {
        switch self {
        case .chat: "Chat"
        case .screen: "Screen"
        case .info: "Info"
        }
    }
}

/// A short message at the bottom of the window ("demo-build: picked 1").
struct Toast: Equatable, Identifiable {
    enum Kind { case info, error }
    let id = UUID()
    var text: String
    var kind: Kind
}

/// Single source of UI state. Main actor; views read it via `@Environment(AppModel.self)`.
@Observable @MainActor
final class AppModel {
    private(set) var service: any DroverService
    let settings: AppSettings
    let tokens: TokenStore
    /// Keychain account `widget`, the read-only token of the widgets and the menu bar. Pairing writes it.
    let widgetTokens: TokenStore
    /// Pairing with the daemon: Settings > Connection, the board's empty state, and launch without a token.
    let pairing: PairingController
    /// Bumped when pairing stored new tokens, so Settings' token rows read the Keychain again.
    private(set) var tokenRevision = 0
    /// A `drover://pair?url=` link's daemon, shown in the main window's pairing sheet until done or cancelled.
    var pairLink: URL?

    // Board
    private(set) var board: BoardSnapshot = .empty
    private(set) var connection: ConnectionState = .notConfigured
    private(set) var isRefreshing = false
    var lastError: String?
    /// Bumped when the stream (re)connects: open chats catch up, the manager re-reads its thread.
    private(set) var resyncTick = 0
    /// The daemon's own short host name (`hello`), for matching events that name it instead of "local".
    private(set) var daemonHost: String?
    /// The daemon said it honours `?topics=` (so `board` events come).
    @ObservationIgnored private var daemonSendsBoard = false

    // Selection and navigation
    var sidebarSelection: SidebarItem = .all
    var selectedSessionKey: String?
    var detailTab: DetailTab = .chat
    var isPaletteOpen = false
    /// Bump to ask the composer to take keyboard focus (the `r` shortcut, notification Reply).
    private(set) var composerFocusRequest = 0
    /// Text to prefill into the composer on the next focus request (e.g. from a notification).
    var composerDraft: [String: String] = [:]

    // Dialog answers
    /// Session key -> the key being pressed.
    private(set) var answering: [String: String] = [:]
    /// Session key -> what the last press left to say (a refusal, or that the dialog moved on).
    var answerNotice: [String: AnswerNote] = [:]
    /// Session key -> a direct reading of its screen, newer than the board (LiveDialogs.swift).
    var liveDialogs: [String: LiveDialog] = [:]
    /// Session key -> its card's open "Type something" field, and the question it answers (FreeTextField).
    var typingAnswer: [String: FreeTextField] = [:]
    private(set) var toast: Toast?
    /// Bumped after a key press so Screen captures again at once.
    private(set) var screenPoke = 0
    /// The main window is on screen (Screen polls only then).
    var isMainWindowVisible = true

    let manager: ManagerModel

    @ObservationIgnored let notifications: NotificationCoordinator
    /// The server URL the current `service` was built for (Settings text may already say something else).
    @ObservationIgnored private(set) var activeServerURL: String
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var pendingRefresh: Task<Void, Never>?
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var lastRefreshAt = Date.distantPast
    @ObservationIgnored private var lastWidgetWrite = Date.distantPast
    /// Bumped by reconfigure(). Results and callbacks from an older service are dropped.
    @ObservationIgnored private(set) var generation = 0
    @ObservationIgnored private var refreshingGeneration: Int?
    @ObservationIgnored private var launchPairingChecked = false
    @ObservationIgnored private var chatCache: [String: ChatModel] = [:]
    @ObservationIgnored private var chatOrder: [String] = []
    /// Session keys whose transcript this app asked the daemon to follow.
    @ObservationIgnored private var followed: [String: (id: String, host: String)] = [:]

    init(settings: AppSettings, tokens: TokenStore, widgetTokens: TokenStore = KeychainTokenStore(account: "widget"),
         service: (any DroverService)? = nil, pairing: PairingController = PairingController(),
         managerDefaults: UserDefaults? = nil) {
        self.settings = settings
        self.tokens = tokens
        self.widgetTokens = widgetTokens
        self.pairing = pairing
        self.service = service ?? LiveDroverService(baseURL: settings.serverURL, tokens: tokens)
        self.activeServerURL = settings.serverURL?.absoluteString ?? ""
        self.notifications = NotificationCoordinator()
        self.manager = ManagerModel(defaults: managerDefaults ?? .standard)
        notifications.model = self
        manager.app = self
    }

    // MARK: derived

    var selectedSession: SessionItem? {
        guard let key = selectedSessionKey else { return nil }
        return board.sessions.first { $0.key == key }
    }

    /// The manager is in the detail column (its sidebar entry, or its strip on the board).
    var showsManager: Bool { sidebarSelection == .manager || selectedSession?.isManager == true }

    var managerSession: SessionItem? {
        let host = board.manager.host
        return board.sessions.first { $0.isManager && (host == nil || $0.host == host) } ?? board.sessions.first(where: \.isManager)
    }

    /// The host to send manager ops to (nil: the daemon's own).
    var managerHost: String? { board.manager.host ?? managerSession?.host }

    var boardLoaded: Bool { board.generatedAt != .distantPast }

    /// Sessions the current sidebar selection shows, in board order (lane, then recency).
    var visibleSessions: [SessionItem] {
        board.sessions.filter { s in
            switch sidebarSelection {
            case .all, .manager: true
            case .lane(let l): s.lane == l
            case .host(let h): s.host == h
            }
        }
    }

    func sessions(in lane: Lane) -> [SessionItem] { visibleSessions.filter { $0.lane == lane } }

    func session(forKey key: String) -> SessionItem? { board.sessions.first { $0.key == key } }

    /// The answer card for `s` shows: the screen (as last read, or as the board says) has a dialog that takes keys, or
    /// its "Type something" field is open.
    func showsAnswerCard(_ s: SessionItem) -> Bool { dialogState(s) != nil || typingAnswer[s.key] != nil }

    // MARK: lifecycle

    /// Start the event stream, the safety poll, and notifications. Idempotent.
    func start() {
        notifications.start()
        guard streamTask == nil else { return }
        let gen = generation
        let stream = service.events { [weak self] state in
            Task { @MainActor in
                guard let self, self.generation == gen else { return }
                self.connection = state
            }
        }
        streamTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.handle(event)
            }
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                // With `board` events the poll is only a safety net; an older daemon's fleet.summary is polled.
                let every: Double = self?.board.source == .board ? 60 : 20
                try? await Task.sleep(for: .seconds(every))
            }
        }
    }

    func stop() {
        streamTask?.cancel(); streamTask = nil
        pollTask?.cancel(); pollTask = nil
        pendingRefresh?.cancel(); pendingRefresh = nil
    }

    /// Rebuild the service after the server URL or token changed, then restart streams.
    func reconfigure() {
        stop()
        generation &+= 1
        service = LiveDroverService(baseURL: settings.serverURL, tokens: tokens)
        activeServerURL = settings.serverURL?.absoluteString ?? ""
        board = .empty
        lastError = nil
        followed = [:]
        chatCache = [:]; chatOrder = []
        manager.reset()
        start()
        Task { await manager.refresh() }
    }

    func refresh() async {
        let gen = generation
        guard refreshingGeneration != gen else { return }
        refreshingGeneration = gen
        isRefreshing = true
        defer {
            if refreshingGeneration == gen { refreshingGeneration = nil; isRefreshing = false }
        }
        let service = self.service
        lastRefreshAt = Date()
        do {
            let snap = try await service.board()
            // A reconfigure happened while this was in flight: this is the old server's data.
            guard gen == generation else { return }
            apply(board: snap)
            lastError = nil
        } catch DroverError.notConfigured {
            guard gen == generation else { return }
            connection = .notConfigured
        } catch {
            guard gen == generation, !(error is CancellationError) else { return }
            lastError = error.localizedDescription
        }
    }

    /// A new board (a read or a `board` event). Assigned only when something changed, so views do not redraw
    /// for a new `generatedAt` alone.
    func apply(board snap: BoardSnapshot) {
        let t0 = PerfLog.now()
        if !snap.sameContent(as: board) {
            board = snap
            updateDockBadge()
            pruneLiveDialogs(snap)
            #if !DROVER_DEV
            handOffToWidgets(snap)
            #endif
        }
        PerfLog.log("apply board", since: t0, "\(snap.sessions.count) sessions, source \(snap.source.rawValue)")
    }

    /// The Dock icon counts the sessions waiting on you.
    private func updateDockBadge() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        let waiting = board.sessions.filter { $0.lane == .waiting }.count
        let label = waiting > 0 ? String(waiting) : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    #if !DROVER_DEV
    private func handOffToWidgets(_ snap: BoardSnapshot) {
        WidgetHandoff.hostsChanged(snap.hosts.map(\.name))
        if let json = snap.nativeSummaryJSON { WidgetHandoff.write(summaryJSON: json); return }
        // native.board boards carry no native.summary: fetch it for the widgets now and then.
        guard Date().timeIntervalSince(lastWidgetWrite) > 120, let live = service as? LiveDroverService else { return }
        lastWidgetWrite = Date()
        Task.detached { if let data = await live.nativeSummaryJSON() { WidgetHandoff.write(summaryJSON: data) } }
    }
    #endif

    /// Coalesce bursts into one refresh `after` seconds later, at most one every `minGap` seconds.
    func scheduleRefresh(after delay: Double = 1, minGap: Double = 0) {
        guard pendingRefresh == nil else { return }
        let wait = max(delay, minGap - Date().timeIntervalSince(lastRefreshAt))
        pendingRefresh = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            if Task.isCancelled { return }
            self?.pendingRefresh = nil
            await self?.refresh()
        }
    }

    /// `board` events keep the board current: refresh only when one does not come.
    private var usesBoardEvents: Bool { board.source == .board || daemonSendsBoard }

    private func handle(_ event: ServerEvent) {
        switch event {
        case .hello(let host, let topics):
            daemonHost = host
            daemonSendsBoard = topics
            scheduleRefresh(after: 0)
            resyncTick &+= 1
            for (_, f) in followed { let service = self.service; Task { await service.follow(id: f.id, host: f.host, on: true) } }
            Task { await manager.refresh() }
        case .board(let snap):
            // A board event is the fresh board: a fallback refresh waiting for it is not needed.
            pendingRefresh?.cancel(); pendingRefresh = nil
            apply(board: snap)
        case .mutation:
            // The daemon warms and sends the board soon after a mutation; refresh only if it does not.
            scheduleRefresh(after: usesBoardEvents ? 3 : 1, minGap: usesBoardEvents ? 0 : 5)
        case .alerts(let items):
            notifications.handle(items)
            if !usesBoardEvents { scheduleRefresh(after: 1, minGap: 5) }
        case .turn(let e):
            route(e)
        case .manager(let m):
            manager.apply(m)
        case .changed:
            if !usesBoardEvents { scheduleRefresh(after: 1, minGap: 5) }
        case .settings, .unknown:
            break
        }
    }

    private func route(_ e: TurnEvent) {
        guard let turn = e.turn else { return }
        if e.sessionId == "manager" || e.thread != nil {
            manager.apply(turn: turn, host: e.host)
            return
        }
        guard let id = e.sessionId else { return }
        for chat in chatCache.values where chat.transcriptId == id && hostMatches(e.host, chat.host) {
            chat.apply(turn)
        }
    }

    /// The `host` arg for an op about a session an alert names. Alerts carry the machine's own name (`hello`'s host)
    /// where the board says "local", and the daemon does not take its own name as a host; a host the board does not
    /// know goes by the session's board entry when the id is unique and names one session fleet-wide. The manager's id
    /// is "manager" on every host that runs one, and a window's own target repeats across machines: the only one of
    /// those on the board says nothing about where the alert came from, so its unknown host stays (the daemon refuses
    /// it) and a reply never lands on another machine's manager or window.
    func opHost(_ host: String?, sessionId: String?) -> String {
        guard let host, !host.isEmpty, host != "local" else { return "local" }
        if board.hosts.contains(where: { $0.name == host }) { return host }
        if host == daemonHost { return "local" }
        if let id = sessionId {
            let matches = board.sessions.filter { $0.id == id || $0.sessionId == id }
            if matches.count == 1, !matches[0].isManager, !matches[0].windowOnly { return matches[0].host }
        }
        return host
    }

    /// An event's host against a session's: no host, the same name, or the daemon's own name for "local".
    func hostMatches(_ eventHost: String?, _ sessionHost: String) -> Bool {
        guard let eventHost, !eventHost.isEmpty else { return true }
        if eventHost == sessionHost { return true }
        let local: Set<String> = ["local", daemonHost ?? "local"]
        return local.contains(eventHost) && local.contains(sessionHost)
    }

    // MARK: chats

    /// The chat model for a session, kept for the last few sessions so switching back is instant.
    func chatModel(for s: SessionItem) -> ChatModel {
        if let c = chatCache[s.key] {
            if chatOrder.last != s.key { chatOrder.removeAll { $0 == s.key }; chatOrder.append(s.key) }
            // Called from a view's body: write only a real change (ChatView's onChange handles the setting too).
            if c.showHidden != settings.showToolTurns { c.showHidden = settings.showToolTurns }
            return c
        }
        let c = ChatModel(key: s.key, transcriptId: s.transcriptId, host: s.host)
        c.showHidden = settings.showToolTurns
        chatCache[s.key] = c
        chatOrder.append(s.key)
        while chatOrder.count > 6 {
            let old = chatOrder.removeFirst()
            if followed[old] == nil { chatCache[old] = nil } else { chatOrder.append(old); break }
        }
        return c
    }

    /// Ask the daemon to follow a Claude transcript while its chat is open (`turn` events), and stop after.
    func follow(_ s: SessionItem, on: Bool) {
        guard s.engine == "claude", !s.windowOnly, !s.isManager else { return }
        let service = self.service, id = s.transcriptId, host = s.host
        if on {
            guard followed[s.key] == nil else { return }
            followed[s.key] = (id, host)
            Task { await service.follow(id: id, host: host, on: true) }
        } else {
            guard followed.removeValue(forKey: s.key) != nil else { return }
            // Not a child task: the view's task is being cancelled, and a cancelled request never leaves.
            Task.detached { await service.follow(id: id, host: host, on: false) }
        }
    }

    // MARK: dialog answers

    /// Press `key` on the dialog `s` shows, only if its screen still hashes to `expect` (the hash the card shows).
    /// One press, no other step. The card then follows the screen: the answered screen hides at once, the pane is
    /// read again until it moved on (the next question, a review screen, nothing), and a refusal shows the dialog now
    /// on screen rather than an error.
    func answer(_ s: SessionItem, key: String, expect: String? = nil) async {
        guard answering[s.key] == nil else { return }
        let state = dialogState(s)
        let hash = expect ?? state?.hash ?? s.hash
        // A press closes the card's "Type something" field; picking that option opens it, once the press took.
        let field = FreeTextField(picking: key, on: state)
        typingAnswer[s.key] = nil
        answering[s.key] = key
        answerNotice[s.key] = nil
        let service = self.service
        // The daemon finds a Claude session's window itself; anything else is answered on its window.
        let id = s.engine == "claude" || s.tmuxTarget == nil ? s.id : s.tmuxTarget ?? s.id
        do {
            let r = try await service.answer(id: id, host: s.host, target: s.tmuxTarget, key: key, expect: hash)
            answering[s.key] = nil
            if r.ok {
                if let field { typingAnswer[s.key] = field }
                // The screen just answered stays hidden until a reading shows what came next.
                let pressed = state.flatMap { st in st.hash.map { ScreenDialog.Reading(dialog: st.dialog ?? DialogInfo(question: nil, options: []), hash: $0, keys: st.keys, held: st.held) } }
                liveDialogs[s.key] = LiveDialog(reading: pressed, at: Date(), pressed: hash)
                show(Toast(text: "\(s.name): \(DialogKeys.pastTense(key, held: state?.held ?? s.held))", kind: .info))
                screenPoke &+= 1
                await followScreen(s, pressed: hash)
            } else if let now = DialogResolver.reading(fromRefusal: r) {
                // "The screen changed since you read it": the dialog that is up now, ready to answer.
                liveDialogs[s.key] = LiveDialog(reading: now, at: Date())
                answerNotice[s.key] = AnswerNote(text: "The dialog moved on. This is the one on screen now.", isError: false)
            } else if (r.reason ?? "").localizedCaseInsensitiveContains("no dialog") {
                liveDialogs[s.key] = LiveDialog(reading: nil, at: Date())
                show(Toast(text: "\(s.name): the dialog is gone", kind: .info))
            } else {
                answerNotice[s.key] = AnswerNote(text: "Not sent: \(r.reason ?? "the daemon refused")", isError: true)
                await readScreen(s)
            }
        } catch {
            answering[s.key] = nil
            answerNotice[s.key] = AnswerNote(text: error.localizedDescription, isError: true)
        }
        scheduleRefresh(after: 0.7)
    }

    /// The text for a "Type something" option, typed into the dialog's own field (the option was pressed first, and the
    /// field closes with this). The pane is read once more right before: the text goes only while the question is up
    /// with its field (FreeTextField.isUp), since the paste is forced and ends with Enter.
    func sendFreeText(_ s: SessionItem, text: String) async {
        guard let target = s.tmuxTarget, !text.isEmpty, let field = typingAnswer.removeValue(forKey: s.key) else { return }
        let service = self.service
        let now: ScreenDialog.Reading?
        do {
            now = ScreenDialog.read(capture: try await service.capture(target: target, host: s.host, lines: 60))
        } catch {
            show(Toast(text: "\(s.name): not sent, the screen could not be read (\(error.localizedDescription))", kind: .error))
            return
        }
        note(reading: now, for: s)
        guard let now, field.isUp(on: now) else {
            show(Toast(text: "\(s.name): not sent, that question is no longer on screen", kind: .error))
            return
        }
        do {
            // The dialog is still on screen (its text field): the guard would refuse a plain paste.
            _ = try await service.sendToPane(target: target, host: s.host, text: text, enter: true, force: true)
            show(Toast(text: "\(s.name): answer sent", kind: .info))
        } catch {
            answerNotice[s.key] = AnswerNote(text: error.localizedDescription, isError: true)
        }
        await followScreen(s, pressed: now.hash)
        scheduleRefresh(after: 0.7)
    }

    /// Press a key in a pane that shows no dialog (Enter, Esc, Ctrl-C, arrows): `tmux.keys`.
    func press(_ key: PaneKey, in s: SessionItem) {
        guard let target = s.tmuxTarget else { return }
        let service = self.service
        Task {
            do { try await service.sendKeys(target: target, host: s.host, keys: [key]) }
            catch { show(Toast(text: error.localizedDescription, kind: .error)) }
            screenPoke &+= 1
            scheduleRefresh(after: 1)
        }
    }

    func show(_ t: Toast) {
        toast = t
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(t.kind == .error ? 6 : 3))
            if !Task.isCancelled, self?.toast?.id == t.id { self?.toast = nil }
        }
    }

    // MARK: pairing

    /// Asks the daemon at `url` (default: the configured one) for its tokens (DroverKit `PairingController`; its
    /// requests carry no token). Once the code is approved on the Mac, both tokens go where Settings' Save token puts
    /// them, the URL becomes the server and the connection is applied: nothing changes before that.
    func startPairing(at url: URL? = nil) {
        guard let url = url ?? settings.serverURL else { return }
        pairing.start(baseURL: url, client: "Drover for Mac", device: Host.current().localizedName ?? "Mac") { [weak self] tokens in
            try self?.storePaired(tokens, from: url)
        }
    }

    /// The pairing sheet's Pair: ask the link's daemon for a code. The same link again keeps the code on screen.
    func confirmPairLink() {
        guard let url = pairLink else { return }
        if pairing.phase.isActive && pairing.serverURL == url { return }
        startPairing(at: url)
    }

    /// The pairing sheet's Cancel or Done: a pairing it started and not yet approved stops.
    func dismissPairLink() {
        if let url = pairLink, pairing.phase.isActive, pairing.serverURL == url { pairing.cancel() }
        pairLink = nil
    }

    /// At launch: with no main token and the daemon on this Mac (the default http://127.0.0.1:7337), pair right
    /// away so the board's empty state shows the code. Once per launch.
    func pairIfUnconfigured() {
        guard !launchPairingChecked else { return }
        launchPairingChecked = true
        guard tokens.read() == nil, let url = settings.serverURL, PairingClient.isLoopback(url), !pairing.phase.isActive else { return }
        startPairing()
    }

    /// Settings' Apply and Save token: what the user configures by hand wins, so a pairing still in flight is cancelled
    /// first and its approval, should one arrive, is dropped.
    func applyConnectionSettings() {
        pairing.cancel()
        reconfigure()
    }

    private func storePaired(_ paired: PairingTokens, from url: URL) throws {
        let previousMain = tokens.read()
        try tokens.write(paired.main)
        do {
            if let widget = paired.widget { try widgetTokens.write(widget) } else { try widgetTokens.delete() }
        } catch {
            // All or nothing: the previous main token comes back (or none), so a failed pairing leaves no new token
            // behind for the next launch to pick up.
            if let previousMain { try? tokens.write(previousMain) } else { try? tokens.delete() }
            throw error
        }
        tokenRevision &+= 1
        // The tokens belong to the daemon that approved, even if the URL field was edited meanwhile. The App Group
        // copy (menu bar, Safari extension, widgets) is written here too: the default URL never was.
        if settings.serverURL != url { settings.serverURLString = url.absoluteString }
        settings.persistServerURL()
        reconfigure()
    }

    // MARK: actions

    func select(_ session: SessionItem?) {
        selectedSessionKey = session?.key
        if session != nil && sidebarSelection == .manager { sidebarSelection = .all }
    }

    /// j / k: move the selection through `visibleSessions`, wrapping is off.
    func selectNext() { moveSelection(by: 1) }
    func selectPrevious() { moveSelection(by: -1) }

    private func moveSelection(by delta: Int) {
        let list = visibleSessions
        guard !list.isEmpty else { return }
        if sidebarSelection == .manager { sidebarSelection = .all }
        guard let key = selectedSessionKey, let i = list.firstIndex(where: { $0.key == key }) else {
            selectedSessionKey = (delta > 0 ? list.first : list.last)?.key
            return
        }
        selectedSessionKey = list[max(0, min(list.count - 1, i + delta))].key
    }

    /// Focus the composer of the selected session (switches to Chat), optionally with a draft.
    func focusComposer(draft: String? = nil) {
        if showsManager { manager.focusComposer(draft: draft); return }
        detailTab = .chat
        if let draft, let key = selectedSessionKey { composerDraft[key] = draft }
        composerFocusRequest &+= 1
    }

    /// The manager in the main window's detail column.
    func showManagerInWindow() {
        sidebarSelection = .manager
        manager.focusComposer()
    }

    /// Select a session by id and host, e.g. from a notification or URL. A missing host means `local`
    /// (CONTRACT.md URL scheme). A host the board knows is honoured strictly (two hosts can both have `manager`);
    /// a host it does not know (hook alerts carry the machine's hostname) falls back to a unique id match.
    /// When nothing matches yet the key is selected anyway and resolves once the board loads.
    @discardableResult
    func reveal(sessionId: String, host: String?) -> Bool {
        let host = (host?.isEmpty == false ? host : nil) ?? "local"
        let knownHost = board.hosts.contains { $0.name == host }
        var match = board.sessions.first { ($0.id == sessionId || $0.sessionId == sessionId) && $0.host == host }
        if match == nil && !knownHost {
            let byId = board.sessions.filter { $0.id == sessionId || $0.sessionId == sessionId }
            if byId.count == 1 { match = byId[0] }
        }
        if sidebarSelection == .manager { sidebarSelection = .all }
        guard let match else {
            sidebarSelection = .all
            selectedSessionKey = "\(host)|\(sessionId)"
            return false
        }
        if !visibleSessions.contains(match) { sidebarSelection = .all }
        selectedSessionKey = match.key
        return true
    }

    /// Apply a `drover://` URL to the model (selection, pairing). Window side effects are WindowRouter's.
    @discardableResult
    func open(url: URL) -> AppRoute? {
        guard let route = AppRoute.parse(url) else { return nil }
        open(route)
        return route
    }

    func open(_ route: AppRoute) {
        switch route {
        case .session(let id, let host):
            reveal(sessionId: id, host: host)
        case .board:
            if sidebarSelection == .manager { sidebarSelection = .all }
        case .manager(let inWindow):
            if inWindow { showManagerInWindow() } else { manager.focusComposer() }
        case .pair(let url):
            // From any app or page: the sheet names the address, and only pairing again with this daemon starts at once
            // (PairLinkPolicy). The server, the token in use and the App Group copy stay as they are until an approval.
            pairLink = url
            if PairLinkPolicy.startsAutomatically(link: url, configured: settings.serverURL) { confirmPairLink() }
        case .debug:
            break
        }
    }
}
