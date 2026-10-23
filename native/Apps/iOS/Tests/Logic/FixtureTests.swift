import Foundation

/// Decodes core's synthetic fixtures (repo-root Fixtures/, written by window 00) with the app's models,
/// so a shape change on either side fails here. Skipped when the directory is absent.
enum FixtureTests {
    static var dir: URL {
        if let override = ProcessInfo.processInfo.environment["DROVER_FIXTURES"] { return URL(fileURLWithPath: override) }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../../Fixtures").standardizedFileURL
    }

    static func data(_ name: String) -> Data? { try? Data(contentsOf: dir.appending(path: name)) }

    static func run() throws {
        guard FileManager.default.fileExists(atPath: dir.appending(path: "native.summary.json").path) else {
            print("fixtures: skipped (no \(dir.path))")
            return
        }
        func result<R: Decodable>(_ file: String, _ op: String, as t: R.Type) throws -> R {
            guard let d = data(file) else { throw DroverError.decoding("missing fixture \(file)") }
            return try HTTPDroverAPI.decodeResult(d, op: op, as: t)
        }
        let s = try result("native.summary.json", "native.summary", as: NativeSummary.self)
        expect(!s.hosts.isEmpty && s.totals.hosts == s.hosts.count, "fixture summary hosts")
        expect(s.waiting.allSatisfy { $0.since != nil && $0.headline != nil }, "fixture waiting since/headline")
        if let bare = data("native-summary.json") {
            let b = try JSONDecoder().decode(NativeSummary.self, from: bare)
            expect(b.totals == s.totals, "bare widget cache file decodes")
        }
        let empty = try result("native.summary.empty.json", "native.summary", as: NativeSummary.self)
        expect(empty.waiting.isEmpty, "empty summary")
        let feed = try result("native.notifications.json", "native.notifications", as: NotificationFeed.self)
        expect(feed.cursor != nil && !feed.items.isEmpty, "fixture notifications")
        expect(feed.items.allSatisfy { $0.at != nil && $0.category != nil }, "notification at/category")
        let list = try result("sessions.list.json", "sessions.list", as: SessionList.self)
        expect(list.sessions.count >= 4, "fixture sessions")
        expect(list.sessions.contains { $0.engine == .openclaw && $0.id == "manager" }, "manager session")
        expect(list.sessions.allSatisfy { $0.startedAt == nil || $0.startedAt!.date.timeIntervalSince1970 > 1.7e9 },
               "epoch ms and s both decode")
        let page = try result("sessions.transcript.json", "sessions.transcript", as: TranscriptPage.self)
        expect(page.offset == 20480 && page.turns.contains { $0.role == "thinking" }, "fixture transcript")
        let msg = try result("sessions.message.json", "sessions.message", as: MessageResult.self)
        expect(msg.ok != false, "fixture message delivered")
        let cap = try result("tmux.capture.json", "tmux.capture", as: ScreenCapture.self)
        expect(!cap.text.isEmpty && cap.screen != nil, "fixture capture")
        let sent = try result("tmux.send.json", "tmux.send", as: PaneSendResult.self)
        expect(sent.refused != true, "fixture send ok")
        let refused = try result("tmux.send.refused.json", "tmux.send", as: PaneSendResult.self)
        expect(refused.refused == true, "fixture send refused")
        if let err = data("error.op.json") {
            do { let _: NativeSummary = try HTTPDroverAPI.decodeResult(err, op: "x"); expect(false, "error envelope throws") }
            catch DroverError.server { expect(true, "error envelope maps to server error") }
        }

        if let sse = data("events.sse.txt") {
            var parser = SSEParser(), lines = SSELineBuffer(), names: [String] = [], datas: [String] = []
            for byte in sse {
                guard let l = lines.feed(byte), let ev = parser.feed(l) else { continue }
                names.append(ev.name); datas.append(ev.data)
            }
            if let ev = parser.flush() { names.append(ev.name); datas.append(ev.data) }
            expect(Array(names.prefix(5)) == ["hello", "mutation", "notify", "alerts", "future-thing"], "fixture sse names \(names)")
            expect(datas.contains("{\"multi\":\n\"line\"}"), "multi-line data joined")
        }
    }
}
