import Foundation
import Observation

/// Transcript state for one chat: a full read on open, `turn` events while the daemon follows the transcript,
/// incremental `since` reads to catch up. Chat rows (`items`) are laid out off the main actor.
@Observable @MainActor
final class ChatModel {
    nonisolated static let maxTurns = 1000

    /// The session key (`host|id`) and the ids `turn` events carry for it.
    let key: String
    let transcriptId: String
    let host: String

    private(set) var turns: [TranscriptTurn] = []
    /// The rows Chat draws, laid out off the main actor.
    let rows = ChatRows()
    var items: [ChatItem] { rows.items }
    private(set) var offset: Int?
    /// From the last page: false means snapshots only (headless, Codex, manager), so reads re-read whole.
    private(set) var incremental = true
    private(set) var isLoading = false
    private(set) var loaded = false
    /// The first read filled its page: older turns exist (Claude transcripts).
    private(set) var hasEarlier = false
    @ObservationIgnored private var pageLimit = LiveDroverService.claudePage
    /// A `turn` event arrived for this chat: the daemon follows it, so polling can stop.
    private(set) var liveAt: Date?
    var error: String?
    /// Meta, queued and title turns (Settings > General).
    var showHidden = false {
        didSet { if showHidden != oldValue { scheduleLayout(delay: 0) } }
    }

    init(key: String = "", transcriptId: String = "", host: String = "") {
        self.key = key
        self.transcriptId = transcriptId
        self.host = host
    }

    /// Full read (`since: nil`); replaces the turns.
    func load(service: any DroverService, session: SessionItem) async {
        isLoading = true
        defer { isLoading = false }
        await fetch(service: service, session: session, since: nil)
    }

    /// Read again with a bigger page, for the turns before the first read (up to the in-memory cap).
    func loadEarlier(service: any DroverService, session: SessionItem) async {
        guard hasEarlier, !isLoading else { return }
        pageLimit = min(Self.maxTurns, pageLimit * 2)
        isLoading = true
        defer { isLoading = false }
        await fetch(service: service, session: session, since: nil)
    }

    /// Incremental read (new turns since the last offset). Without a usable offset this is a full reload.
    func poll(service: any DroverService, session: SessionItem) async {
        if incremental, let offset, offset > 0 {
            await fetch(service: service, session: session, since: offset)
        } else {
            await fetch(service: service, session: session, since: nil)
        }
    }

    private func fetch(service: any DroverService, session: SessionItem, since: Int?) async {
        do {
            let page = try await service.transcript(of: session, since: since,
                                                    limit: since == nil && session.engine == "claude" ? pageLimit : nil)
            if Task.isCancelled { return }
            if since == nil { hasEarlier = page.incremental && (page.sent ?? page.turns.count) >= pageLimit && pageLimit < Self.maxTurns }
            let merged = Self.merge(existing: turns, page: page, incremental: since != nil)
            if since == nil || page.offset != nil { offset = page.offset ?? offset }
            if since == nil { incremental = page.incremental }
            error = nil
            loaded = true
            if merged != turns {
                turns = merged
                scheduleLayout(delay: 0)
            } else if items.isEmpty && !turns.isEmpty {
                scheduleLayout(delay: 0)
            }
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled { return }
            self.error = error.localizedDescription
        }
    }

    /// A turn from a `turn` event. Appended unless already known (the next incremental read dedupes by id too).
    func apply(_ turn: TranscriptTurn) {
        liveAt = Date()
        if let i = turns.lastIndex(where: { $0.id == turn.id }) {
            guard turns[i] != turn else { return }
            turns[i] = turn
        } else {
            turns.append(turn)
            if turns.count > Self.maxTurns { turns.removeFirst(turns.count - Self.maxTurns) }
        }
        // Coalesce a burst of turns (one per transcript line) into one layout pass.
        scheduleLayout(delay: 0.05)
    }

    /// Pure merge used by `load` and `poll`.
    nonisolated static func merge(existing: [TranscriptTurn], page: TranscriptPage, incremental: Bool) -> [TranscriptTurn] {
        var result: [TranscriptTurn]
        if incremental {
            var seen = Set(existing.map(\.id))
            result = existing
            for turn in page.turns where seen.insert(turn.id).inserted { result.append(turn) }
        } else {
            result = page.turns
        }
        if result.count > maxTurns { result.removeFirst(result.count - maxTurns) }
        return result
    }

    private func scheduleLayout(delay: Double) {
        rows.schedule(turns, options: ChatLayout.Options(showHidden: showHidden), delay: delay)
    }

    /// Wait for the pending layout pass (the harness).
    func layoutSettled() async { await rows.settled() }
}

/// Chat rows for a list of turns, laid out off the main actor with a Markdown cache, so an update only parses the
/// turns it has not seen. Shared by session chats and the manager.
@Observable @MainActor
final class ChatRows {
    private(set) var items: [ChatItem] = []
    /// Tool groups opened, and results or code blocks shown in full (row ids).
    var expanded: Set<String> = []
    var showAll: Set<String> = []
    @ObservationIgnored private var cache: ChatLayout.Cache = [:]
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var revision = 0

    func schedule(_ turns: [TranscriptTurn], options: ChatLayout.Options, delay: Double) {
        revision &+= 1
        let revision = self.revision, cache = self.cache
        task?.cancel()
        task = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            if Task.isCancelled { return }
            let t0 = PerfLog.now()
            let built = await Task.detached(priority: .userInitiated) { ChatLayout.build(turns, options: options, cache: cache) }.value
            guard let self, !Task.isCancelled, revision == self.revision else { return }
            self.cache = built.cache
            if built.items != self.items { self.items = built.items }
            PerfLog.log("chat layout", since: t0, "\(turns.count) turns -> \(built.items.count) rows")
        }
    }

    func settled() async { await task?.value }
}
