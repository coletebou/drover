import Foundation
import Observation

/// Foreground state for the watch app. Views read it from the environment
/// (`@Environment(AppModel.self)`); it owns no WatchKit or WatchConnectivity code so it
/// compiles and tests on macOS.
@MainActor @Observable
final class AppModel {
    enum Phase: Equatable, Sendable {
        case idle, loading, loaded
        case failed(String)
    }

    private(set) var summary: NativeSummary?
    private(set) var phase: Phase = .idle
    private(set) var lastUpdated: Date?
    private(set) var hasMainToken = false
    private(set) var hasWidgetToken = false
    private(set) var baseURL: URL?
    /// Navigation stack of the list (owned here so unpair and server changes can reset it).
    var path: [WaitingItem] = []
    /// A deep link that did not resolve yet (the item may arrive with the next refresh).
    private(set) var pendingDeepLink: DeepLink?
    /// Called with waiting items that are new since the last fetch (the app plays a haptic).
    @ObservationIgnored var onNewWaiting: (@MainActor ([WaitingItem]) -> Void)?
    /// Called after summary.json was rewritten (the app reloads complication timelines).
    @ObservationIgnored var onSummaryCached: (@MainActor () -> Void)?

    @ObservationIgnored let vault: any TokenVault
    @ObservationIgnored let config: WatchConfig
    @ObservationIgnored let cache: SummaryCache
    @ObservationIgnored let seen: SeenWaitingStore
    @ObservationIgnored let session: URLSession
    @ObservationIgnored private let offline: Bool
    /// A refresh was requested while one was in flight (for example new tokens arrived).
    @ObservationIgnored private var refreshAgain = false

    init(vault: any TokenVault = KeychainTokenVault(), config: WatchConfig = WatchConfig(),
         cache: SummaryCache = .standard(), seen: SeenWaitingStore = SeenWaitingStore(),
         session: URLSession = .shared, offline: Bool = false) {
        self.vault = vault
        self.config = config
        self.cache = cache
        self.seen = seen
        self.session = session
        self.offline = offline
        if let cached = cache.load() {
            summary = cached
            phase = .loaded
        }
        reloadCredentials()
    }

    var isConfigured: Bool { baseURL != nil && (hasWidgetToken || hasMainToken) }
    var canReply: Bool { baseURL != nil && hasMainToken }
    var waiting: [WaitingItem] { summary?.waiting ?? [] }

    func item(id: String, host: String?) -> WaitingItem? {
        waiting.first { $0.id == id && (host == nil || $0.host == host) }
    }

    /// Re-read flags after the iPhone synced new settings. Never reads token values into state.
    func reloadCredentials() {
        baseURL = config.baseURL
        hasMainToken = vault.has(.main)
        hasWidgetToken = vault.has(.widget)
    }

    /// Forget everything shown from the current server (unpair or server change).
    func clearData() {
        summary = nil
        lastUpdated = nil
        phase = .idle
        pendingDeepLink = nil
        path = []
    }

    /// Pick up a summary.json written by the background download while this model was alive.
    func reloadFromCache() {
        guard let cached = cache.load() else { return }
        let newer = (cached.generatedAt?.date ?? .distantPast) > (summary?.generatedAt?.date ?? .distantPast)
        if summary == nil || newer {
            summary = cached
            if phase == .idle { phase = .loaded }
        }
    }

    var fetcher: SummaryFetcher {
        SummaryFetcher(vault: vault, config: config, cache: cache, seen: seen, session: session)
    }

    /// `allowMainToken` must be false unless the app is frontmost: background work polls with
    /// the read-only widget token only.
    func refresh(allowMainToken: Bool = true) async {
        guard !offline else { applyPendingLink(final: true); return }
        guard phase != .loading else { refreshAgain = true; return }
        defer {
            if refreshAgain {
                refreshAgain = false
                Task { await self.refresh(allowMainToken: allowMainToken) }
            }
        }
        reloadCredentials()
        guard isConfigured, allowMainToken || hasWidgetToken else {
            phase = .failed(baseURL == nil ? WatchClientError.notConfigured.message : WatchClientError.missingToken(.widget).message)
            return
        }
        phase = .loading
        do {
            // Snapshot and commit on the main actor (see SummaryFetcher); only the network wait
            // happens off it.
            let f = fetcher
            let creds = try f.credentials(allowMainToken: allowMainToken)
            let (fresh, raw) = try await f.download(creds)
            guard f.isCurrent(creds) else { throw WatchClientError.superseded }
            let out = f.commit(fresh, raw: raw)
            summary = out.summary
            lastUpdated = Date()
            phase = .loaded
            onSummaryCached?()
            if !out.newWaiting.isEmpty { onNewWaiting?(out.newWaiting) }
            applyPendingLink(final: true)
        } catch WatchClientError.superseded {
            phase = summary == nil ? .idle : .loaded
        } catch let e as WatchClientError {
            phase = .failed(e.message)
        } catch {
            phase = .failed("Refresh failed")
        }
    }

    private func mainClient() throws -> (WatchClient, String) {
        guard let base = config.baseURL else { throw WatchClientError.notConfigured }
        guard let token = vault.token(.main), !token.isEmpty else { throw WatchClientError.missingToken(.main) }
        return (WatchClient(baseURL: base, session: session), token)
    }

    /// The session's last message (main token).
    func lastReply(for item: WaitingItem) async throws -> LastReply? {
        if offline { return PreviewData.lastReply(for: item) }
        let (client, token) = try mainClient()
        return try await client.lastReply(id: item.id, host: item.host, token: token)
    }

    /// Send a reply into the session (main token), then refresh so the item leaves the list.
    func send(_ text: String, to item: WaitingItem) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if offline { return }
        let (client, token) = try mainClient()
        try await client.sendMessage(id: item.id, host: item.host, text: trimmed, token: token)
        await refresh()
    }

    func open(_ url: URL) {
        guard let link = DeepLink(url: url) else { return }
        pendingDeepLink = link
        reloadFromCache()
        applyPendingLink(final: false)
    }

    /// Navigate to the pending link. A session link that does not resolve is kept until a
    /// refresh completed (`final`), then dropped (the session stopped waiting).
    func applyPendingLink(final: Bool) {
        guard let link = pendingDeepLink else { return }
        switch link {
        case .board, .manager:
            path = []
            pendingDeepLink = nil
        case .session:
            if let item = ListRouting.route(link, in: waiting) {
                path = [item]
                pendingDeepLink = nil
            } else if final {
                pendingDeepLink = nil
            }
        }
    }

    /// Model with synthetic fixture data and no network (SwiftUI previews).
    static func preview(summary: NativeSummary? = PreviewData.summary, canReply: Bool = true) -> AppModel {
        let defaults = UserDefaults(suiteName: "drover.preview") ?? .standard
        let config = WatchConfig(defaults: defaults)
        config.baseURL = URL(string: "http://127.0.0.1:7337")
        let tmp = FileManager.default.temporaryDirectory.appending(path: "drover-preview-summary.json")
        let m = AppModel(vault: MemoryTokenVault(main: canReply ? "preview" : nil, widget: "preview"),
                         config: config, cache: SummaryCache(fileURL: tmp),
                         seen: SeenWaitingStore(defaults: defaults), offline: true)
        m.summary = summary
        m.phase = .loaded
        m.lastUpdated = Date()
        return m
    }
}
