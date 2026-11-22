import DroverKit
import Foundation
import Observation

/// The Prompts tab's state (docs/specs/2026-11-21-cohesion-overhaul.md "Prompts: the spool"): `prompts.list` on the
/// daemon, which fans out to every host, newest first. The search field is its `q` (every word must match,
/// debounced), the scope picker is its `who` (Mine, Manager, Agents, Programs, Not mine, All; Mine leaves `who` to
/// the daemon's default), the end of the list pages with `before`, pull to refresh reads the first page again. The
/// status line is `prompts.status`; Sync now is `prompts.sync`; mark(_:mine:) is `prompts.mark`. Owned by AppModel
/// (`AppModel.prompts`), which resets it when the connection changes. No UIKit: Tests/run-logic-tests.sh runs it.
@Observable @MainActor
final class PromptsStore {
    @ObservationIgnored weak var app: AppModel?

    var search = "" { didSet { if search != oldValue { searchChanged() } } }
    var scope: PromptsQuery.Scope = .mine { didSet { if scope != oldValue { Task { await reload() } } } }

    private(set) var records: [PromptRecord] = []
    private(set) var more = false
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var loaded = false
    private(set) var error: String?
    /// The daemon predates the prompt spool ("unknown op prompts.list").
    private(set) var unsupported = false
    /// Hosts that did not answer (and have no sink copy).
    private(set) var downHosts: [String] = []
    private(set) var status: PromptsStatus?
    private(set) var syncing = false
    /// What the last Sync now came to, for the status row (cleared on the next reload).
    private(set) var syncNote: String?

    @ObservationIgnored var debounce: Duration = .milliseconds(350)
    @ObservationIgnored var pageSize = PromptsQuery.pageSize
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var debounceTask: Task<Void, Never>?

    var query: PromptsQuery {
        PromptsQuery(scope: scope, q: search.trimmingCharacters(in: .whitespacesAndNewlines), limit: pageSize)
    }

    func record(id: String) -> PromptRecord? { records.first { $0.id == id } }

    /// First appearance: the first page and the status line.
    func appear() async {
        guard !loaded, !loading else { return }
        async let page: Void = reload()
        async let st: Void = refreshStatus()
        _ = await (page, st)
    }

    /// The first page for the current query (pull to refresh, a new search or scope). An older answer is dropped.
    func reload() async {
        debounceTask?.cancel(); debounceTask = nil
        guard let api = app?.api else { return }
        generation &+= 1
        let gen = generation, q = query
        loading = true
        let result: Result<PromptsList, Error>
        do { result = .success(try await api.prompts(q)) } catch { result = .failure(error) }
        guard gen == generation else { return }
        loading = false
        loaded = true
        switch result {
        case .success(let page):
            records = page.prompts
            more = page.more
            downHosts = page.downHosts.map(\.host)
            error = nil
            unsupported = false
        case .failure(let e):
            if Self.isUnknownOp(e) { unsupported = true; error = nil; records = []; more = false }
            else { error = e.localizedDescription }
        }
    }

    /// The next page, when the list reaches its end and the daemon said there is more.
    func loadMore() async {
        guard more, !loading, !loadingMore, let last = records.last, let api = app?.api else { return }
        loadingMore = true
        defer { loadingMore = false }
        let gen = generation, q = query.after(last)
        do {
            let page = try await api.prompts(q)
            guard gen == generation else { return }
            let before = records.count
            records = PromptsMerge.merge(records, page.prompts)
            more = page.more && records.count > before
        } catch {
            guard gen == generation else { return }
            self.error = "Could not read older prompts: \(error.localizedDescription)"
            more = false
        }
    }

    func refreshStatus() async {
        guard let api = app?.api else { return }
        let gen = generation
        if let s = try? await api.promptsStatus(), gen == generation { status = s }
    }

    /// Sync now: scan the transcripts and push every sink, then read the list and the status again.
    func sync() async {
        guard !syncing, let api = app?.api else { return }
        syncing = true
        do { syncNote = try await api.syncPrompts().summary }
        catch { syncNote = "Sync failed: \(error.localizedDescription)" }
        syncing = false
        await reload()
        await refreshStatus()
    }

    /// Mark one prompt mine or not (`prompts.mark`); `mine: nil` clears the mark, back to the via default.
    /// Reloads after: the current scope may no longer include it (marking it not mine while viewing Mine, say).
    func mark(_ p: PromptRecord, mine: Bool?) async {
        guard let api = app?.api else { return }
        do {
            _ = try await api.markPrompts(ids: [p.id], mine: mine)
            await reload()
            await refreshStatus()
        } catch {
            self.error = "Could not mark the prompt: \(error.localizedDescription)"
        }
    }

    /// Another server or token (AppModel.reconnect): start over.
    func reset() {
        generation &+= 1
        debounceTask?.cancel(); debounceTask = nil
        records = []; more = false; loading = false; loadingMore = false; loaded = false
        error = nil; unsupported = false; downHosts = []; status = nil; syncNote = nil
    }

    private func searchChanged() {
        debounceTask?.cancel()
        let wait = debounce
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled, let self else { return }
            // Detach first: reload() cancels a pending debounce, and this one is no longer pending (cancelling it
            // would cancel the read it starts). A newer keystroke's reload drops this answer by generation.
            self.debounceTask = nil
            await self.reload()
        }
    }

    // MARK: the session behind a prompt

    /// The prompt's session as the app opens one, when it is on the board now (a live session in the list, or a
    /// waiting or working item of the summary) on the host the record's route names. nil otherwise.
    func sessionRef(for p: PromptRecord) -> SessionRef? {
        guard let app, let sid = p.session, sid != SessionRef.manager.id else { return nil }
        let ref = SessionRef(id: sid, host: p.route)
        let onBoard = app.sessions.contains { $0.id == sid && $0.ref.displayHost == ref.displayHost }
            || app.summary?.waiting.contains { $0.id == sid && $0.ref.displayHost == ref.displayHost } == true
            || app.summary?.working.contains { $0.id == sid && $0.ref.displayHost == ref.displayHost } == true
        return onBoard ? ref : nil
    }

    // MARK: formatting

    /// The meta line of a row: "22:03 · demo-box · codex · webapp · queued".
    nonisolated static func meta(_ p: PromptRecord, now: Date = Date(), calendar: Calendar = .current) -> String {
        var parts = [time(p.ts.date, now: now, calendar: calendar), p.host, p.engine.rawValue]
        if let project = p.project { parts.append(project) }
        if let from = p.from { parts.append("from \(from)") } else if let via = p.via, !via.label.isEmpty { parts.append(via.label) }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// "22:03" today, "Tue 22:03" this week, else "21 Nov 22:03" (24-hour, like the web UI).
    nonisolated static func time(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = calendar.timeZone
        if calendar.isDate(date, inSameDayAs: now) { f.dateFormat = "HH:mm" }
        else if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day, days < 6 { f.dateFormat = "EEE HH:mm" }
        else { f.dateFormat = "d MMM HH:mm" }
        return f.string(from: date)
    }

    /// The daemon answered "unknown op prompts.list" (it predates the spool).
    nonisolated static func isUnknownOp(_ e: Error) -> Bool {
        if case DroverError.server(let m) = e { return m.localizedCaseInsensitiveContains("unknown op") }
        return false
    }
}
