import DroverKit
import Foundation

/// The prompt spool (CONTRACT.md "Ops added 2026-11-21"), in DroverKit's models. Every `DroverAPI` is one; the
/// defaults say the client cannot ask (the unconfigured client, test doubles).
protocol PromptsAPI: Sendable {
    /// `prompts.list`: every prompt typed into Claude Code or Codex, fleet-wide, newest first. Main token only.
    func prompts(_ query: PromptsQuery) async throws -> PromptsList
    /// `prompts.status` on the daemon's own machine.
    func promptsStatus() async throws -> PromptsStatus
    /// `prompts.sync` (a write, main token): scan now, then push every sink.
    func syncPrompts() async throws -> PromptsSyncResult
}

extension PromptsAPI {
    func prompts(_ query: PromptsQuery) async throws -> PromptsList { throw DroverError.notConfigured }
    func promptsStatus() async throws -> PromptsStatus { throw DroverError.notConfigured }
    func syncPrompts() async throws -> PromptsSyncResult { throw DroverError.notConfigured }
}

extension HTTPDroverAPI {
    /// `PromptsQuery.arguments` as this app's own JSON values (the same JSON, through its Codable form).
    static func promptArgs(_ query: PromptsQuery) throws -> [String: JSONValue] {
        try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(query))
    }

    func prompts(_ query: PromptsQuery) async throws -> PromptsList {
        try await op("prompts.list", Self.promptArgs(query))
    }

    func promptsStatus() async throws -> PromptsStatus {
        try await op("prompts.status")
    }

    /// A sync pushes git sinks over the network: it waits as long as the daemon gives each host for it.
    func syncPrompts() async throws -> PromptsSyncResult {
        try await op("prompts.sync", ["actor": .string(DroverIDs.actor)], timeout: 150)
    }
}

extension MockDroverAPI {
    /// Synthetic prompts on the mock board's sessions (so Open session has somewhere to go).
    static let promptsFixture: [PromptRecord] = {
        let at = { (minutes: Double) in DroverTimestamp(now.addingTimeInterval(-minutes * 60)) }
        return [
            PromptRecord(id: "p_mock000000000001", ts: at(4), host: "demo-mac", engine: .claude, session: "11111111-aaaa-4bbb-8ccc-000000000001",
                         cwd: "~/code/demo", project: "demo", label: "work", via: .typed,
                         text: "Make the demo parser keep line numbers in its errors, then run the tests.", route: "local"),
            PromptRecord(id: "p_mock000000000002", ts: at(16), host: "demo-box", engine: .codex, session: "thread-demo-review",
                         cwd: "~/code/webapp", project: "webapp", label: "work", via: .queued,
                         text: "Review the login form for accessibility:\n\n- labels\n- focus order\n- error messages read by a screen reader",
                         route: "demo-box"),
            PromptRecord(id: "p_mock000000000003", ts: at(48), host: "demo-mac", engine: .claude, session: "11111111-aaaa-4bbb-8ccc-000000000002",
                         cwd: "~/code/docs", project: "docs", label: "work", via: .drover, text: "continue", route: "local"),
            PromptRecord(id: "p_mock000000000004", ts: at(200), host: "demo-spare", engine: .claude, cwd: "~/notes", project: "notes",
                         label: "personal", via: .headless,
                         text: "Sort the notes into projects, people and reference; leave anything unsure in an inbox folder.",
                         source: "sink:personal"),
            PromptRecord(id: "p_mock000000000005", ts: at(260), host: "demo-mac", engine: .claude, session: "11111111-aaaa-4bbb-8ccc-000000000001",
                         cwd: "~/code/demo", project: "demo", label: "work", via: .peer,
                         text: "The review found two nits in the lexer; see the notes at the end of the diff.", from: "demo-review", route: "local"),
        ]
    }()

    func prompts(_ query: PromptsQuery) async throws -> PromptsList {
        try await Task.sleep(for: delay)
        let words = (query.q ?? "").lowercased().split(separator: " ").map(String.init)
        let mine = Set(PromptVia.mine)
        var all = Self.promptsFixture.filter { p in
            (query.scope == .all || p.via.map(mine.contains) ?? true) && words.allSatisfy { p.text.lowercased().contains($0) }
        }
        if let before = query.before, let i = all.firstIndex(where: { $0.id == before }) { all = Array(all[(i + 1)...]) }
        let limit = query.limit ?? PromptsQuery.pageSize
        return PromptsList(ms: 1, prompts: Array(all.prefix(limit)), more: all.count > limit,
                           perHost: [.init(host: "demo-mac", ok: true, count: all.count)])
    }

    func promptsStatus() async throws -> PromptsStatus {
        PromptsStatus(host: "demo-mac", enabled: true, files: 12, records: 412, newest: DroverTimestamp(Self.now.addingTimeInterval(-240)),
                      sinks: [.init(name: "personal", type: "git", lastSync: DroverTimestamp(Self.now.addingTimeInterval(-600)))])
    }

    func syncPrompts() async throws -> PromptsSyncResult {
        try await Task.sleep(for: delay)
        return PromptsSyncResult(host: "demo-mac", scanned: 30, added: 1, sinks: [.init(name: "personal", type: "git", ok: true, added: 1, pushed: true)])
    }
}
