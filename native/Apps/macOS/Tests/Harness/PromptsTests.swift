import DroverKit
import Foundation

// The Prompts screen: route, first page, Mine and All, debounced search, paging, selection, the session behind a
// prompt, sync and an older daemon.
@MainActor
enum PromptsTests {
    static func model(_ mock: MockDroverService = MockDroverService()) async -> AppModel {
        let m = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                         tokens: MemoryTokenStore("x"), service: mock)
        await m.refresh()
        m.prompts.debounce = .milliseconds(40)
        return m
    }

    /// Wait (at most ~3 s) for `cond`.
    static func until(_ cond: () -> Bool) async {
        for _ in 0..<300 where !cond() { try? await Task.sleep(for: .milliseconds(10)) }
    }

    static func run() async {
        await T.suite("Prompts: drover://prompts") {
            T.eq(AppRoute.parse(URL(string: "drover://prompts")!), .prompts(query: nil))
            T.eq(AppRoute.parse(URL(string: "drover://prompts?q=lexer%20tests")!), .prompts(query: "lexer tests"))
            let m = await model()
            m.open(.prompts(query: "lexer"))
            T.eq(m.sidebarSelection, .prompts)
            T.eq(m.prompts.search, "lexer")
            m.open(.board)
            T.eq(m.sidebarSelection, .all, "the board route leaves Prompts")
        }
        await T.suite("Prompts: first page, Mine and All, status") {
            let mock = MockDroverService()
            let m = await model(mock)
            m.sidebarSelection = .prompts
            m.prompts.appear()
            await until { m.prompts.loaded && m.prompts.status != nil }
            T.eq(m.prompts.records.count, 4, "Mine leaves the peer message out")
            T.check(m.prompts.records.allSatisfy { $0.via != .peer })
            T.eq(mock.promptsAsked.last?.arguments, ["limit": 200], "Mine sends no via: the daemon's default")
            T.check(m.prompts.status?.line().hasPrefix("1,204 prompts") == true, "status line")
            m.prompts.scope = .all
            await until { m.prompts.records.count == 5 }
            T.eq(m.prompts.records.count, 5, "All brings the peer message")
            T.eq(mock.promptsAsked.last?.arguments["via"], "all")
            T.eq(m.prompts.records.map(\.id), m.prompts.records.sorted { $0.ts > $1.ts }.map(\.id), "newest first")
        }
        await T.suite("Prompts: search is debounced and asks the daemon") {
            let mock = MockDroverService()
            let m = await model(mock)
            m.prompts.appear()
            await until { m.prompts.loaded }
            let asked = mock.promptsAsked.count
            m.prompts.search = "t"
            m.prompts.search = "te"
            m.prompts.search = "the tests"
            await until { mock.promptsAsked.count > asked && !m.prompts.loading }
            try? await Task.sleep(for: .milliseconds(120))
            T.eq(mock.promptsAsked.count, asked + 1, "three keystrokes, one request")
            T.eq(mock.promptsAsked.last?.q, "the tests")
            T.eq(m.prompts.records.map(\.id), ["p_0d1e2f3a4b5c6d7e"], "every word must match")
            m.prompts.search = "no such words anywhere"
            await until { m.prompts.records.isEmpty }
            T.check(m.prompts.records.isEmpty, "nothing matches")
        }
        await T.suite("Prompts: paging with before while more") {
            let mock = MockDroverService()
            let m = await model(mock)
            m.prompts.pageSize = 2
            m.prompts.appear()
            await until { m.prompts.loaded }
            T.eq(m.prompts.records.count, 2)
            T.check(m.prompts.more)
            m.prompts.loadMore()
            await until { m.prompts.records.count == 4 }
            T.eq(mock.promptsAsked.last?.before, "p_1a2b3c4d5e6f7081", "before is the last record shown")
            T.eq(m.prompts.records.count, 4)
            T.check(!m.prompts.more, "the last page")
            let asked = mock.promptsAsked.count
            m.prompts.loadMore()
            T.eq(mock.promptsAsked.count, asked, "no request past the end")
        }
        await T.suite("Prompts: selection, j and k") {
            let m = await model()
            m.sidebarSelection = .prompts
            m.prompts.appear()
            await until { m.prompts.loaded }
            m.selectNext()
            T.eq(m.prompts.selectedID, m.prompts.records.first?.id, "j selects the first prompt, not a session")
            T.eq(m.selectedSessionKey, nil)
            m.selectNext()
            T.eq(m.prompts.selectedID, m.prompts.records[1].id)
            m.selectPrevious()
            T.eq(m.prompts.selected?.id, m.prompts.records.first?.id)
        }
        await T.suite("Prompts: the session behind a prompt, and Open session") {
            let m = await model()
            m.sidebarSelection = .prompts
            let onBoard = PromptRecord(id: "p_x", ts: DroverTimestamp(Date()), host: "studio", engine: .claude,
                                       session: "11111111-demo-build", text: "hi", route: "studio")
            T.eq(m.prompts.session(for: onBoard)?.name, "demo-build")
            var elsewhere = onBoard; elsewhere.route = "spare"
            T.eq(m.prompts.session(for: elsewhere)?.name, nil, "the same id on another host is not this session")
            var noSession = onBoard; noSession.session = nil
            T.check(m.prompts.session(for: noSession) == nil)
            var manager = onBoard; manager.session = "manager"
            T.check(m.prompts.session(for: manager) == nil, "never the manager by id")
            m.prompts.openSession(onBoard)
            T.eq(m.sidebarSelection, .all, "the board shows")
            T.eq(m.selectedSession?.name, "demo-build")
            T.eq(m.detailTab, .chat)
        }
        await T.suite("Prompts: sync now") {
            let mock = MockDroverService()
            let m = await model(mock)
            await m.prompts.sync()
            T.eq(mock.promptSyncs, 1)
            T.check(m.toast?.text.hasPrefix("Scanned 412, added 3 prompts") == true, "the result as a toast")
            T.eq(m.toast?.kind, .error, "a failed sink makes it an error toast")
        }
        await T.suite("Prompts: a daemon without the spool") {
            let mock = MockDroverService()
            mock.promptsUnknown = true
            let m = await model(mock)
            m.prompts.appear()
            await until { m.prompts.loaded }
            T.check(m.prompts.unsupported)
            T.eq(m.prompts.error, nil, "not shown as an error")
        }
        await T.suite("Prompts: times") {
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = TimeZone(identifier: "UTC")!
            let now = ISO8601DateFormatter().date(from: "2026-11-21T23:00:00Z")!
            let t = { (s: String) in PromptsModel.time(ISO8601DateFormatter().date(from: s)!, now: now, calendar: cal) }
            T.eq(t("2026-11-21T22:03:11Z"), "22:03")
            T.eq(t("2026-11-18T09:05:00Z"), "Wed 09:05")
            T.eq(t("2026-10-02T09:05:00Z"), "2 Oct 09:05")
        }
    }
}
