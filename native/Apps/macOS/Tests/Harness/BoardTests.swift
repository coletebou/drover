import Foundation

// Owned by the Board slice.
@MainActor
enum BoardTests {
    static func run() async {
        await T.suite("BoardFormat.relative") {
            let now = Date(timeIntervalSince1970: 1_800_000_000)
            T.eq(BoardFormat.relative(nil, now: now), "")
            T.eq(BoardFormat.relative(now.addingTimeInterval(-3), now: now), "now")
            T.check(BoardFormat.relative(now.addingTimeInterval(-300), now: now).contains("5"), "5 minutes")
            T.check(BoardFormat.relative(now.addingTimeInterval(-3 * 3600), now: now).contains("3"), "3 hours")
            T.check(BoardFormat.relative(now.addingTimeInterval(-300), now: now).contains("ago"), "past tense")
        }
        await T.suite("BoardFormat.droverLink") {
            func s(_ id: String, _ host: String) -> SessionItem {
                SessionItem(id: id, name: "n", host: host, engine: "claude", status: "idle", cwd: nil, tmuxTarget: nil,
                            live: true, updatedAt: nil, lane: .idle, waitKind: nil, headline: nil)
            }
            T.eq(BoardFormat.droverLink(for: s("a b/c", "studio")).absoluteString, "drover://session/a%20b%2Fc?host=studio")
            T.eq(BoardFormat.droverLink(for: s("abc", "local")).absoluteString, "drover://session/abc")
            T.eq(BoardFormat.droverLink(for: s("abc", "")).absoluteString, "drover://session/abc")
        }
        await T.suite("BoardFormat.hostCaption") {
            func h(_ up: Bool, _ w: Int, _ k: Int, _ i: Int, _ e: String? = nil) -> HostItem {
                HostItem(name: "x", up: up, waiting: w, working: k, idle: i, error: e)
            }
            T.eq(BoardFormat.hostCaption(h(true, 2, 1, 0)), "2 waiting · 1 working")
            T.eq(BoardFormat.hostCaption(h(true, 0, 3, 1)), "3 working")
            T.eq(BoardFormat.hostCaption(h(true, 0, 0, 4)), "idle")
            T.eq(BoardFormat.hostCaption(h(false, 0, 0, 0, "ssh timed out")), "offline · ssh timed out")
            T.eq(BoardFormat.hostCaption(h(false, 0, 0, 0)), "offline")
            var stale = h(true, 1, 0, 2); stale.stale = true
            T.eq(BoardFormat.hostCaption(stale), "1 waiting · last known", "the daemon shows what it saw last")
        }
        await T.suite("BoardFormat.laneCounts") {
            let snap = (try? await MockDroverService().board()) ?? .empty
            let c = BoardFormat.laneCounts(snap.sessions)
            T.eq(c[.waiting] ?? 0, 2)
            T.eq(c[.working] ?? 0, 2)
            T.eq(c[.idle] ?? 0, 2)
            T.eq(BoardFormat.subtitle(snap.sessions[0]), "studio · claude · work:1")
            T.eq(BoardFormat.subtitle(snap.sessions[3]), "devbox · headless")
            T.eq(BoardFormat.summaryLine(snap.sessions[4]), "idle")
            T.eq(BoardFormat.shortId("11111111-demo-build"), "11111111")
        }
    }
}
