import Foundation
import Observation

/// Root state of the app: configuration, the cached board summary, the fleet's sessions,
/// navigation (tab and selection) and the live SSE subscription. One instance, injected with
/// `.environment(model)`. Feature screens own their own per-screen state (chat, manager, ...).
@MainActor
@Observable
final class AppModel {
    enum Tab: String, Hashable, CaseIterable { case board, sessions, manager, settings }

    enum Connection: Equatable {
        case unconfigured
        case connecting
        case online
        /// Only the widget token is configured: board works, actions need the main token.
        case readOnly
        case failed(String)
    }

    // Navigation
    var selectedTab: Tab = .board
    var boardSelection: SessionRef?
    var sessionsSelection: SessionRef?
    /// Daemon address from a `drover://pair?url=` link. Settings fills it in, pairs and clears it.
    var pendingPairURL: URL?

    // Data
    private(set) var summary: NativeSummary?
    private(set) var summaryError: String?
    private(set) var sessions: [SessionInfo] = []
    private(set) var sessionsError: String?
    private(set) var isRefreshing = false
    private(set) var connection: Connection = .unconfigured
    private(set) var lastRefresh: Date?

    // Configuration
    private(set) var api: any DroverAPI
    let vault: TokenVault
    let settings: SharedSettings
    private let isMock: Bool
    private var liveTask: Task<Void, Never>?
    /// True while the scene is active, so a reconnect can resume the SSE subscription.
    private var liveWanted = false
    /// One request in flight per channel; a call made meanwhile waits for it and triggers one rerun,
    /// so bursts never pile up, never apply an older response last, and never starve each other.
    private let summaryFlight = SingleFlight()
    private let sessionsFlight = SingleFlight()
    /// Called (coalesced) when the stream reports new alerts; NotificationManager uses it to poll.
    var onAlertEvent: (@MainActor () -> Void)?

    init(api: (any DroverAPI)? = nil, vault: TokenVault = TokenVault(), settings: SharedSettings = SharedSettings()) {
        self.vault = vault
        self.settings = settings
        self.isMock = api != nil
        // A write interrupted by a crash leaves the revision odd forever: the app is the only writer, so heal it.
        if api == nil, settings.configRevision % 2 != 0 { settings.configRevision &+= 1 }
        self.api = api ?? AppModel.makeAPI(vault: vault, settings: settings) ?? UnconfiguredDroverAPI()
        self.summary = isMock ? nil : SummaryCache.load()
        self.connection = isMock || AppModel.makeAPI(vault: vault, settings: settings) != nil ? .connecting : .unconfigured
    }

    static func preview() -> AppModel { AppModel(api: MockDroverAPI(delay: .zero)) }

    /// A `--mock` launch (DroverApp): synthetic data, no Keychain, settings kept out of the App Group.
    /// `--mock-tab <tab>` and `--mock-session <id>` pick the first screen, for screenshots.
    static func mock(arguments: [String]) -> AppModel {
        let m = AppModel(api: MockDroverAPI(), vault: TokenVault(usesKeychain: false),
                         settings: SharedSettings(suiteName: "drover.mock"))
        func value(_ flag: String) -> String? {
            arguments.firstIndex(of: flag).flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
        }
        if let tab = value("--mock-tab").flatMap(Tab.init(rawValue:)) { m.selectedTab = tab }
        if let id = value("--mock-session") {
            m.open(MockDroverAPI.sessionsFixture.first { $0.id == id }?.ref ?? SessionRef(id: id), in: m.selectedTab)
        }
        return m
    }

    var isConfigured: Bool { connection != .unconfigured }
    var hasMainToken: Bool { isMock || (isConfigured && vault.has(.main)) }

    /// Builds a live client, preferring the main token, else the read-only widget token. The URL and the
    /// token are captured together, so a client built for one server never sends another server's token.
    nonisolated static func makeAPI(vault: TokenVault = TokenVault(), settings: SharedSettings = SharedSettings()) -> (any DroverAPI)? {
        // Sequence lock with `configure`: an odd or changed revision means a write was in progress, so the
        // URL and token might belong to different servers. Give up (callers retry on their next tick)
        // rather than ever send one server's token to another.
        let before = settings.configRevision
        guard before % 2 == 0,
              let url = settings.baseURL,
              let token = vault.read(.main).flatMap({ $0.isEmpty ? nil : $0 }) ?? vault.read(.widget).flatMap({ $0.isEmpty ? nil : $0 }),
              settings.configRevision == before
        else { return nil }
        return HTTPDroverAPI(baseURL: url, token: { token })
    }

    // MARK: configuration

    /// Saves the server address and what to do with each token (keep, store, delete), then reconnects.
    func configure(baseURL raw: String, mainToken: TokenVault.Change, widgetToken: TokenVault.Change) throws {
        guard let url = SharedSettings.normalizedURL(raw) else { throw DroverError.server("Enter a valid http or https address.") }
        settings.configRevision &+= 1  // odd: write in progress, makeAPI refuses to build
        do {
            settings.baseURL = url
            try vault.apply(mainToken, for: .main)
            try vault.apply(widgetToken, for: .widget)
        } catch {
            // Fail closed: after a partial write the stored tokens may belong to different servers, so
            // forget the address (no client can be built, nothing is sent anywhere) and leave the tokens
            // as they are. The user enters the address again.
            settings.baseURL = nil
            settings.configRevision &+= 1
            reconnect()
            throw DroverError.server("Saving failed (\(error.localizedDescription)). The server address was cleared so no token goes to the wrong server; enter it again.")
        }
        settings.configRevision &+= 1  // even: consistent again, before reconnect builds the client
        reconnect()
    }

    /// Rebuilds the client from stored settings and refreshes.
    func reconnect() {
        guard !isMock else { return }
        cancelLive()
        if let api = AppModel.makeAPI(vault: vault, settings: settings) {
            self.api = api
            connection = .connecting
            Task {
                await refreshAll()
                // Re-read the foreground intent after the await: the scene may have gone to the background.
                if liveWanted { startLive() }
            }
        } else {
            api = UnconfiguredDroverAPI()
            connection = .unconfigured
            summary = nil
            sessions = []
        }
    }

    // MARK: refresh

    func refreshAll() async {
        await refreshSummary()
        await refreshSessions()
    }

    func refreshSummary() async {
        await summaryFlight.run { [weak self] in await self?.fetchSummary() }
    }

    private func fetchSummary() async {
        guard isConfigured else { return }
        isRefreshing = true
        defer { isRefreshing = false; lastRefresh = Date() }
        do {
            let s = try await api.summary()
            summary = s
            summaryError = nil
            if !isMock { SummaryCache.store(s) }
            connection = hasMainToken ? .online : .readOnly
        } catch {
            summaryError = error.localizedDescription
            if case DroverError.unauthorized = error { connection = .failed(error.localizedDescription) }
            else if summary == nil { connection = .failed(error.localizedDescription) }
        }
    }

    /// Lists sessions on every host the summary says is up (plus local), in parallel.
    func refreshSessions() async {
        await sessionsFlight.run { [weak self] in await self?.fetchSessions() }
    }

    private func fetchSessions() async {
        guard isConfigured, hasMainToken else { sessions = []; return }
        let hosts = Set((summary?.hosts.filter(\.up).map(\.name) ?? []) + [localHostName])
        let api = self.api
        var merged: [SessionInfo] = []
        var errors: [String] = []
        await withTaskGroup(of: (String, Result<[SessionInfo], Error>).self) { group in
            for h in hosts {
                group.addTask {
                    do { return (h, .success(try await api.sessions(host: h == localHostName ? nil : h))) }
                    catch { return (h, .failure(error)) }
                }
            }
            for await (h, r) in group {
                switch r {
                case .success(let list): merged += list.map { var s = $0; s.host = h; return s }
                case .failure(let e): errors.append("\(h): \(e.localizedDescription)")
                }
            }
        }
        sessions = merged.sorted { ($0.isLive ? 0 : 1, $0.title.lowercased()) < ($1.isLive ? 0 : 1, $1.title.lowercased()) }
        sessionsError = errors.isEmpty ? nil : errors.sorted().joined(separator: "\n")
    }

    func session(for ref: SessionRef) -> SessionInfo? {
        sessions.first { $0.id == ref.id && $0.ref.displayHost == ref.displayHost }
            ?? sessions.first { $0.id == ref.id }
    }

    /// The board state of a session, from the summary when it is listed there.
    func boardState(for ref: SessionRef) -> BoardState {
        if summary?.waiting.contains(where: { $0.id == ref.id }) == true { return .waiting }
        if summary?.working.contains(where: { $0.id == ref.id }) == true { return .working }
        let s = session(for: ref)
        return BoardState(status: s?.status, engine: s?.engine ?? .unknown)
    }

    // MARK: navigation

    /// Opens a session from a deep link, a notification or a board card.
    func open(_ ref: SessionRef, in tab: Tab = .sessions) {
        if ref.id == SessionRef.manager.id { selectedTab = .manager; return }
        selectedTab = tab
        switch tab {
        case .board: boardSelection = ref
        default: sessionsSelection = ref
        }
    }

    /// Handles `drover://session/<id>?host=<h>`, `drover://board`, `drover://manager`, `drover://settings`,
    /// `drover://pair?url=<base URL>`.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let route = DeepLink(url: url) else { return false }
        switch route {
        case .board: selectedTab = .board
        case .manager: selectedTab = .manager
        case .settings: selectedTab = .settings
        case .session(let ref): open(ref)
        case .pair(let base):
            pendingPairURL = base
            selectedTab = .settings
        }
        return true
    }

    // MARK: live updates (foreground only)

    /// Subscribes to `/api/stream` and refreshes on relevant events, reconnecting with backoff.
    /// Throttled, not debounced (a stream of `turn` events must not starve the refresh): at most one
    /// summary refresh per 0.8 s, one session list refresh per 3 s, one alert poll per 1 s.
    func startLive() {
        liveWanted = true
        guard liveTask == nil, isConfigured, hasMainToken, !isMock else { return }
        liveTask = Task { [weak self] in
            var backoff: Double = 1
            var throttle = LiveThrottle()
            while !Task.isCancelled {
                guard let api = self?.api else { return }
                do {
                    for try await ev in api.events() {
                        backoff = 1
                        let kind = LiveEventKind(name: ev.name)
                        if kind == .ignore { continue }
                        let now = ContinuousClock.now
                        if throttle.claim(.summary, at: now, window: .milliseconds(800)) {
                            Task { [weak self] in
                                try? await Task.sleep(for: .milliseconds(800))
                                await self?.refreshSummary()
                            }
                        }
                        if kind == .board, throttle.claim(.sessions, at: now, window: .seconds(3)) {
                            Task { [weak self] in
                                try? await Task.sleep(for: .seconds(3))
                                await self?.refreshSessions()
                            }
                        }
                        if kind == .alerts, throttle.claim(.alerts, at: now, window: .seconds(1)) {
                            Task { [weak self] in
                                try? await Task.sleep(for: .seconds(1))
                                self?.onAlertEvent?()
                            }
                        }
                    }
                } catch {
                    if case DroverError.unauthorized = error { return }
                    if case DroverError.forbidden = error { return }
                }
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 60)
            }
        }
    }

    /// Stops the subscription (scene left the foreground).
    func stopLive() {
        liveWanted = false
        cancelLive()
    }

    /// Cancels the subscription without changing the foreground intent (used by reconnect).
    private func cancelLive() {
        liveTask?.cancel()
        liveTask = nil
    }
}

/// One pending refresh per channel per window.
struct LiveThrottle {
    enum Channel: Hashable { case summary, sessions, alerts }
    private var due: [Channel: ContinuousClock.Instant] = [:]

    /// True when nothing is scheduled for `channel` (the caller schedules it to run after `window`).
    mutating func claim(_ channel: Channel, at now: ContinuousClock.Instant, window: Duration) -> Bool {
        if let d = due[channel], now < d { return false }
        due[channel] = now + window
        return true
    }
}

/// How the app reacts to an SSE event name (unknown names are ignored).
enum LiveEventKind: Equatable {
    case board, alerts, ignore
    init(name: String) {
        switch name {
        case "mutation", "snapshot", "fleet", "turn", "headless", "codex": self = .board
        case "notify", "alerts": self = .alerts
        default: self = .ignore
        }
    }
}

/// Parsed `drover://` deep links (CONTRACT.md "Apple identifiers").
enum DeepLink: Equatable {
    case board, manager, settings
    case session(SessionRef)
    /// `drover://pair?url=<percent-encoded base URL>`: Settings with the address filled in, pairing.
    case pair(URL)

    init?(url: URL) {
        guard url.scheme?.lowercased() == DroverIDs.urlScheme else { return nil }
        let host = url.host()?.lowercased() ?? ""
        let parts = url.pathComponents.filter { $0 != "/" }
        switch host {
        case "board", "": self = .board
        case "manager": self = .manager
        case "settings": self = .settings
        case "session":
            guard let id = parts.first?.removingPercentEncoding, !id.isEmpty else { return nil }
            let h = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "host" }?.value
            self = .session(SessionRef(id: id, host: h))
        case "pair":
            guard let base = Self.pairAddress(url) else { return nil }
            self = .pair(base)
        default: return nil
        }
    }

    /// The daemon address of a pair link. Exactly one parameter, `url`, holding an http or https URL with no
    /// credentials, query or fragment: a link can never bring a token along, not even one the app would ignore.
    static func pairAddress(_ link: URL) -> URL? {
        guard let items = URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems, items.count == 1,
              items[0].name == "url", let raw = items[0].value?.trimmingCharacters(in: .whitespacesAndNewlines),
              let c = URLComponents(string: raw), let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
              c.host?.isEmpty == false, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil
        else { return nil }
        return SharedSettings.normalizedURL(raw)
    }
}
