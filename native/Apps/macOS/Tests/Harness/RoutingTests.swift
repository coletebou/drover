import Foundation

// URL and window routing: what a drover:// (or the dev build's droverdev://) URL asks for, and what it does to the model.
@MainActor
enum RoutingTests {
    static func model() -> AppModel {
        AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                 tokens: MemoryTokenStore("x"), service: MockDroverService(),
                 managerDefaults: UserDefaults(suiteName: "harness-\(UUID())")!)
    }

    static func run() async {
        await T.suite("AppRoute.parse") {
            func p(_ s: String) -> AppRoute? { AppRoute.parse(URL(string: s)!) }
            T.eq(p("drover://session/abc?host=studio"), .session(id: "abc", host: "studio"))
            T.eq(p("drover://session/abc"), .session(id: "abc", host: nil), "no host: local")
            T.eq(p("drover://session/abc?host="), .session(id: "abc", host: nil), "empty host: local")
            T.eq(p("drover://session/a%20b%2Fc?host=studio"), .session(id: "a b/c", host: "studio"), "percent-encoded id")
            T.eq(p("droverdev://session/abc?host=local"), .session(id: "abc", host: "local"), "the dev build's scheme")
            T.eq(p("drover://session"), nil, "no id")
            T.eq(p("drover://board"), .board)
            T.eq(p("drover://anything-else"), .board, "unknown host: the board")
            T.eq(p("drover://manager"), .manager(inWindow: false), "the floating panel")
            T.eq(p("drover://manager?in=window"), .manager(inWindow: true))
            T.eq(p("drover://manager/window"), .manager(inWindow: true))
            T.eq(p("drover://pair?url=http%3A%2F%2F100.64.0.1%3A7337"), .pair(URL(string: "http://100.64.0.1:7337")!))
            T.eq(p("drover://pair?url=ftp%3A%2F%2Fx"), .board, "pairing only with http(s)")
            T.eq(p("drover://pair?url=https%3A%2F%2Fmac.example.ts.net%3A8446%2Fdrover"), .pair(URL(string: "https://mac.example.ts.net:8446/drover")!))
            T.eq(p("drover://pair?url=http%3A%2F%2Fu%3Asecret%40100.64.0.1%3A7337"), .board, "no credentials in the address")
            T.eq(p("drover://pair?url=http%3A%2F%2F100.64.0.1%3A7337&token=abc"), .board, "a pair link carries only the address")
            T.eq(p("drover://pair?url=http%3A%2F%2F100.64.0.1%3A7337%2F%3Ftoken%3Dabc"), .board, "no query inside the address")
            T.eq(p("drover://pair?url=http%3A%2F%2F100.64.0.1%23frag"), .board, "no fragment")
            T.eq(p("drover://pair?url=http%3A%2F%2F%2Fx"), .board, "an address names a host")
            T.eq(p("drover://pair"), .board, "no address")
            T.eq(p("droverdev://debug/close-main"), .debug("close-main", [:]))
            T.eq(p("drover://debug/close-main"), nil, "test hooks only on the dev scheme")
            T.eq(p("https://example.com/session/abc"), nil, "other schemes")
            T.check(p("drover://manager")?.showsPanel == true, "manager -> panel")
            T.check(p("drover://manager?in=window")?.showsPanel == false)
            T.check(p("drover://session/abc")?.showsPanel == false, "sessions -> the main window")
        }
        await T.suite("AppModel.open applies a route, never a window") {
            let m = model()
            await m.refresh()
            m.sidebarSelection = .lane(.idle)
            T.eq(m.open(url: URL(string: "droverdev://session/33333333-demo-docs?host=studio")!), .session(id: "33333333-demo-docs", host: "studio"))
            T.eq(m.selectedSession?.name, "demo-docs")
            T.eq(m.sidebarSelection, .all, "filter cleared to reveal it")
            // Five more opens of the same link change nothing else: the router only brings the one window forward.
            for _ in 0..<5 { m.open(url: URL(string: "drover://session/33333333-demo-docs?host=studio")!) }
            T.eq(m.selectedSession?.name, "demo-docs")
            m.open(url: URL(string: "drover://manager?in=window")!)
            T.check(m.showsManager, "manager in the detail column")
            m.open(url: URL(string: "drover://board")!)
            T.eq(m.sidebarSelection, .all, "board leaves the manager view")
            T.check(m.open(url: URL(string: "mailto:x@example.com")!) == nil, "foreign URL ignored")
        }
        await T.suite("AppModel.opHost: alerts name the machine, ops want the board's host") {
            let m = model()
            await m.refresh()
            T.eq(m.opHost(nil, sessionId: nil), "local")
            T.eq(m.opHost("studio", sessionId: "x"), "studio", "a host the board knows")
            T.eq(m.opHost("Some-Mac", sessionId: "11111111-demo-build"), "studio", "an unknown name goes by the unique session")
            T.eq(m.opHost("Some-Mac", sessionId: "nope"), "Some-Mac", "nothing better known")
            // Replies and answers from alerts use this host (NotificationCoordinator.reply, .answer).
            T.eq(m.opHost("Some-Mac", sessionId: "manager"), "Some-Mac", "every manager is \"manager\": the only one on the board is not the alert's")
            var snap = MockDroverService.snapshot
            snap.sessions.append(SessionItem(id: "work:7", name: "work:7", host: "devbox", engine: "shell", status: "busy", cwd: nil,
                                             tmuxTarget: "work:7", live: true, updatedAt: nil, lane: .working, waitKind: nil, headline: nil,
                                             windowOnly: true))
            m.apply(board: snap)
            T.eq(m.opHost("Some-Mac", sessionId: "work:7"), "Some-Mac", "nor is the only window with that target")
            T.eq(m.opHost("Some-Mac", sessionId: "11111111-demo-build"), "studio", "a session id still finds its host")
        }
        await T.suite("DevSnapshotPath: the dev build's snapshot hook writes only a .png in the temp directory") {
            T.eq(DevSnapshotPath.resolve(nil)?.path, "/tmp/drover-dev-window.png", "the default")
            T.check(DevSnapshotPath.resolve("/tmp/shot.png") != nil, "/tmp")
            T.check(DevSnapshotPath.resolve(FileManager.default.temporaryDirectory.appending(path: "shot.png").path) != nil, "this user's temp directory")
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            T.eq(DevSnapshotPath.resolve(home + "/.zshrc"), nil, "a URL from any app or page: not over a file of yours")
            T.eq(DevSnapshotPath.resolve(home + "/Desktop/shot.png"), nil, "not outside the temp directory")
            T.eq(DevSnapshotPath.resolve("/tmp/../etc/shot.png"), nil, "no way out with ..")
            T.eq(DevSnapshotPath.resolve("/tmp/no-such-dir-\(UUID())/shot.png"), nil, "only a directory that exists")
            T.eq(DevSnapshotPath.resolve("shot.png"), nil, "nor one relative to wherever the app runs")
            let link = URL(fileURLWithPath: "/tmp/drover-harness-\(UUID())")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: FileManager.default.homeDirectoryForCurrentUser)
            defer { try? FileManager.default.removeItem(at: link) }
            T.eq(DevSnapshotPath.resolve(link.path + "/shot.png"), nil, "a link in /tmp to a folder elsewhere is not /tmp")
        }
        await T.suite("Notification taps route inside the app") {
            let open = NotificationResponseRoute.decide(action: "com.apple.UNNotificationDefaultActionIdentifier",
                                                        info: NotificationAction(sessionId: "s1", host: "studio", server: "http://a"),
                                                        text: nil, activeServer: "http://a")
            T.eq(open, .open, "a tap opens the session (WindowRouter.openSession, no URL)")
            T.eq(NotificationResponseRoute.decide(action: "open", info: NotificationAction(sessionId: "s1"), text: nil, activeServer: nil), .open)
            let m = model()
            await m.refresh()
            // What WindowRouter.openSession does to the model.
            m.reveal(sessionId: "11111111-demo-build", host: "studio")
            T.eq(m.selectedSession?.name, "demo-build")
        }
    }
}
