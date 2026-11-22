import AppKit
import DroverKit
import Foundation
import Observation

/// Prompts › Mine, Manager, Agents, Programs, Not mine and All (docs/specs/2026-11-21-cohesion-overhaul.md "Prompts:
/// the spool"): every prompt typed into Claude Code or Codex on any machine, newest first, from `prompts.list` on the
/// daemon (which fans out to every host). The search field is its `q` (every word must match, debounced), the scope
/// picker is its `who` (Mine leaves it to the daemon's default), the host menu is its `host`. Scrolling to the end
/// pages with `before`. New user turns refresh the top at most every few seconds while the screen shows. The status
/// line is `prompts.status`; Sync now is `prompts.sync`; mark(_:mine:) is `prompts.mark`. Owned by AppModel
/// (`AppModel.prompts`), which resets it when the server changes.
@Observable @MainActor
final class PromptsModel {
    @ObservationIgnored weak var app: AppModel?

    // What to ask for
    /// The search field; every change reloads after `debounce` of quiet.
    var search = "" { didSet { if search != oldValue { searchChanged() } } }
    var scope: PromptsQuery.Scope = .mine { didSet { if scope != oldValue { reload() } } }
    /// A host alias from the board (nil: every host).
    var hostFilter: String? { didSet { if hostFilter != oldValue { reload() } } }

    // What came back
    private(set) var records: [PromptRecord] = []
    private(set) var more = false
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var error: String?
    /// The daemon predates the prompt spool ("unknown op prompts.list").
    private(set) var unsupported = false
    /// Hosts that did not answer (and have no sink copy): their prompts are missing from the list.
    private(set) var downHosts: [String] = []
    private(set) var loaded = false
    var selectedID: String?

    // Status and sync
    private(set) var status: PromptsStatus?
    private(set) var statusError: String?
    private(set) var syncing = false

    /// Bumped by Command F: the search field takes focus.
    private(set) var searchFocusRequest = 0

    @ObservationIgnored var debounce: Duration = .milliseconds(300)
    /// Prompts per page (`limit`).
    @ObservationIgnored var pageSize = PromptsQuery.pageSize
    /// At most one live refresh of the top every this long.
    @ObservationIgnored var liveGap: TimeInterval = 4
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var debounceTask: Task<Void, Never>?
    @ObservationIgnored private var liveTask: Task<Void, Never>?
    @ObservationIgnored private var lastLive = Date.distantPast

    var selected: PromptRecord? { selectedID.flatMap { id in records.first { $0.id == id } } }

    /// The query the screen shows now (the first page).
    var query: PromptsQuery {
        PromptsQuery(scope: scope, q: search.trimmingCharacters(in: .whitespacesAndNewlines), host: hostFilter, limit: pageSize)
    }

    /// Host aliases to filter by: the board's hosts, the daemon's own first.
    var hostChoices: [String] { app?.board.hosts.map(\.name) ?? [] }

    // MARK: loading

    /// First appearance: the first page and the status line.
    func appear() {
        guard !loaded, !loading else { return }
        reload()
        refreshStatus()
    }

    /// The first page for the current query, replacing the list. An answer to an older query is dropped.
    func reload() {
        debounceTask?.cancel(); debounceTask = nil
        guard let service = app?.service else { return }
        generation &+= 1
        let gen = generation, q = query
        loading = true
        Task { [weak self] in
            let result: Result<PromptsList, Error>
            do { result = .success(try await service.prompts(q)) } catch { result = .failure(error) }
            guard let self, gen == self.generation else { return }
            self.loading = false
            self.loaded = true
            switch result {
            case .success(let page):
                self.records = page.prompts
                self.more = page.more
                self.downHosts = page.downHosts.map(\.host)
                self.error = nil
                self.unsupported = false
                if let id = self.selectedID, !page.prompts.contains(where: { $0.id == id }) { self.selectedID = nil }
            case .failure(let e):
                self.apply(error: e)
            }
        }
    }

    /// The next page (`before` = the last record shown), while the daemon says there is more.
    func loadMore() {
        guard more, !loading, !loadingMore, let last = records.last, let service = app?.service else { return }
        loadingMore = true
        let gen = generation, q = query.after(last)
        Task { [weak self] in
            let result: Result<PromptsList, Error>
            do { result = .success(try await service.prompts(q)) } catch { result = .failure(error) }
            guard let self, gen == self.generation else { return }
            self.loadingMore = false
            switch result {
            case .success(let page):
                let before = self.records.count
                self.records = PromptsMerge.merge(self.records, page.prompts)
                // A page that brought nothing new ends the paging (a cursor the hosts no longer know).
                self.more = page.more && self.records.count > before
            case .failure(let e):
                self.error = "Could not read older prompts: \(e.localizedDescription)"
                self.more = false
            }
        }
    }

    /// New prompts at the top, the pages already read kept. Throttled: at most one every `liveGap` seconds.
    func noteActivity() {
        guard loaded, !unsupported, app?.sidebarSelection == .prompts, liveTask == nil else { return }
        let wait = max(0.6, liveGap - Date().timeIntervalSince(lastLive))
        liveTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            self.liveTask = nil
            self.lastLive = Date()
            await self.refreshTop()
        }
    }

    func refreshTop() async {
        guard !loading, let service = app?.service else { return }
        let gen = generation, q = query
        guard let page = try? await service.prompts(q), gen == generation else { return }
        records = PromptsMerge.merge(page.prompts, records)
        downHosts = page.downHosts.map(\.host)
    }

    private func searchChanged() {
        debounceTask?.cancel()
        let wait = debounce
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            self?.reload()
        }
    }

    private func apply(error e: Error) {
        if let d = e as? DroverError, d.isUnknownOp {
            unsupported = true
            error = nil
            records = []
            more = false
        } else {
            error = e.localizedDescription
        }
    }

    // MARK: status and sync

    func refreshStatus() {
        guard let service = app?.service else { return }
        let gen = generation
        Task { [weak self] in
            do {
                let s = try await service.promptsStatus()
                guard let self, gen == self.generation else { return }
                self.status = s; self.statusError = nil
            } catch {
                guard let self, gen == self.generation else { return }
                self.statusError = (error as? DroverError)?.isUnknownOp == true ? nil : error.localizedDescription
            }
        }
    }

    /// Sync now: scan the transcripts and push every sink, then read the list and the status again.
    func sync() async {
        guard !syncing, let service = app?.service else { return }
        syncing = true
        defer { syncing = false }
        do {
            let r = try await service.syncPrompts()
            app?.show(Toast(text: r.summary, kind: r.sinks.contains { !$0.ok } ? .error : .info))
        } catch {
            app?.show(Toast(text: "Sync failed: \(error.localizedDescription)", kind: .error))
        }
        reload()
        refreshStatus()
    }

    /// Mark prompts mine or not (`prompts.mark`); `mine: nil` clears the mark, back to the via default. Reloads
    /// after: the current scope may no longer include the prompt (marking it not mine while viewing Mine, say).
    func mark(_ ids: [String], mine: Bool?) async {
        guard let service = app?.service, !ids.isEmpty else { return }
        do {
            _ = try await service.markPrompts(ids: ids, mine: mine)
            reload()
            refreshStatus()
        } catch {
            app?.show(Toast(text: "Could not mark: \(error.localizedDescription)", kind: .error))
        }
    }

    /// One prompt (a context menu or detail action).
    func mark(_ p: PromptRecord, mine: Bool?) async { await mark([p.id], mine: mine) }

    /// Another server: start over (AppModel.reconfigure).
    func reset() {
        generation &+= 1
        debounceTask?.cancel(); debounceTask = nil
        liveTask?.cancel(); liveTask = nil
        records = []; more = false; loading = false; loadingMore = false
        error = nil; unsupported = false; downHosts = []; loaded = false; selectedID = nil
        status = nil; statusError = nil
    }

    // MARK: selection and actions

    func focusSearch() { searchFocusRequest &+= 1 }

    /// j / k through the list.
    func selectNext() { move(by: 1) }
    func selectPrevious() { move(by: -1) }

    private func move(by delta: Int) {
        guard !records.isEmpty else { return }
        guard let id = selectedID, let i = records.firstIndex(where: { $0.id == id }) else {
            selectedID = (delta > 0 ? records.first : records.last)?.id
            return
        }
        let n = max(0, min(records.count - 1, i + delta))
        selectedID = records[n].id
        if n >= records.count - 5 { loadMore() }
    }

    /// The prompt, verbatim, on the pasteboard.
    func copy(_ p: PromptRecord) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(p.text, forType: .string)
        app?.show(Toast(text: "Copied: \(p.firstLine(max: 60))", kind: .info))
    }

    /// The board strip of the prompt's session, when it is on the board now (its host by the record's route).
    func session(for p: PromptRecord) -> SessionItem? {
        guard let app, let sid = p.session else { return nil }
        let host = p.route ?? p.host
        return app.board.sessions.first { s in
            !s.isManager && (s.id == sid || s.sessionId == sid || s.transcriptId == sid) && app.hostMatches(host, s.host)
        }
    }

    /// Open session: the board with that session selected, on its Chat (how a palette pick opens one).
    func openSession(_ p: PromptRecord) {
        guard let app, let s = session(for: p) else { return }
        app.sidebarSelection = .all
        app.select(s)
        app.detailTab = .chat
    }

    /// "22:03" today, "Tue 22:03" this week, else "21 Nov 22:03" (24-hour, like the web UI).
    static func time(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now) { f.dateFormat = "HH:mm" }
        else if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day, days < 6 { f.dateFormat = "EEE HH:mm" }
        else { f.dateFormat = "d MMM HH:mm" }
        return f.string(from: date)
    }
}
