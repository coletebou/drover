import Foundation

// Logic tests of the board slice.
extension Suites {
    static var boardSuites: [(String, () async throws -> Void)] { [("board", board)] }

    static func board() async throws {
        // kind labels
        expect(BoardFormat.kindLabel("decision") == "Decision", "decision label")
        expect(BoardFormat.kindLabel("question") == "Question", "question label")
        expect(BoardFormat.kindLabel("finished") == "Finished", "capitalized kind")
        expect(BoardFormat.kindLabel(nil) == "Waiting", "nil kind")
        expect(BoardFormat.kindLabel("") == "Waiting", "empty kind")
        expect(BoardFormat.countsSentence(waiting: 1, working: 2, idle: 3) == "1 waiting, 2 working, 3 idle", "counts")
        expect(BoardFormat.managerLabel(up: true) == "Manager up", "manager up")
        expect(BoardFormat.managerLabel(up: nil) == "Manager down", "manager unknown is down")
        expect(BoardFormat.waitingIncreased(from: 1, to: 2), "increase")
        expect(!BoardFormat.waitingIncreased(from: nil, to: 2), "no haptic on first load")
        expect(!BoardFormat.waitingIncreased(from: 2, to: 2), "no haptic when equal")
        expect(BoardFormat.totalsSentence(.init(waiting: 1, working: 0, idle: 2, hosts: 1)).hasSuffix("1 host"), "singular host")

        // sessions filter
        let list = [
            SessionInfo(id: "a1", engine: .claude, name: "Alpha", status: "busy", cwd: "/work/demo-build", tmux: "native:@1.%2", live: true, host: "local"),
            SessionInfo(id: "b2", engine: .codex, name: "Beta", status: "waiting", cwd: "/srv/api/", live: true, host: "devbox"),
            SessionInfo(id: "c3", engine: .claude, name: nil, status: "idle", cwd: nil, live: false, host: "devbox"),
            SessionInfo(id: "d4", engine: .claude, name: "Delta", status: "idle", live: true, host: "alpha-box"),
        ]
        let st: (SessionRef) -> BoardState = { ref in
            switch ref.id { case "b2": .waiting; case "a1": .working; default: .idle }
        }
        let all = SessionsFilter.apply(list, filter: .all, query: "", state: st)
        expect(all.map(\.host) == ["local", "alpha-box", "devbox"], "local first then alphabetical: \(all.map(\.host))")
        expect(all[2].sessions.count == 2, "devbox has two")
        let live = SessionsFilter.apply(list, filter: .live, query: "", state: st)
        expect(live.flatMap(\.sessions).map(\.id) == ["a1", "d4", "b2"] || live.flatMap(\.sessions).count == 3, "live excludes not live")
        expect(!live.flatMap(\.sessions).contains { $0.id == "c3" }, "c3 not live")
        let waiting = SessionsFilter.apply(list, filter: .waiting, query: "", state: st)
        expect(waiting.count == 1 && waiting[0].sessions[0].id == "b2", "waiting filter")
        let working = SessionsFilter.apply(list, filter: .working, query: "", state: st)
        expect(working.count == 1 && working[0].host == "local", "working filter")
        expect(SessionsFilter.apply(list, filter: .all, query: "  DELTA ", state: st).flatMap(\.sessions).map(\.id) == ["d4"], "name search, case and trim")
        expect(SessionsFilter.apply(list, filter: .all, query: "c3", state: st).flatMap(\.sessions).count == 1, "id search")
        expect(SessionsFilter.apply(list, filter: .all, query: "demo-build", state: st).flatMap(\.sessions).map(\.id) == ["a1"], "cwd search")
        expect(SessionsFilter.apply(list, filter: .all, query: "native:@1", state: st).flatMap(\.sessions).map(\.id) == ["a1"], "tmux search")
        expect(SessionsFilter.apply(list, filter: .all, query: "alpha-box", state: st).flatMap(\.sessions).map(\.id) == ["d4"], "host search")
        expect(SessionsFilter.apply(list, filter: .all, query: "zzz", state: st).isEmpty, "no match")
        expect(SessionsFilter.apply(list, filter: .live, query: "c3", state: st).isEmpty, "filter and query combine")
        expect(SessionsFilter.lastPathComponent("/srv/api/") == "api", "trailing slash")
        expect(SessionsFilter.lastPathComponent("/work/demo-build") == "demo-build", "last component")
        expect(SessionsFilter.lastPathComponent("/") == nil, "root")
        expect(SessionsFilter.lastPathComponent(nil) == nil, "nil cwd")
    }
}
