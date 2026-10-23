import Foundation

// The event stream: line splitting over arbitrary chunks, events whose data is never decoded, and the new events.
@MainActor
enum SSETests {
    final class Sink: @unchecked Sendable {
        private let lock = NSLock()
        private var _messages: [SSEParser.Message] = []
        var messages: [SSEParser.Message] { lock.withLock { _messages } }
        func add(_ m: SSEParser.Message) { lock.withLock { _messages.append(m) } }
    }

    static func connection(_ sink: Sink) -> SSEConnection {
        SSEConnection(skipData: ServerEventMapper.skipData, onOpen: {}, onMessage: { sink.add($0) })
    }

    static func run() async {
        await T.suite("SSEParser skipData") {
            var p = SSEParser(skipData: ["fleet"])
            var out: [SSEParser.Message] = []
            for l in ["event: fleet", "data: {\"huge\":1}", "", "event: board", "data: {\"strips\":[]}", ""] {
                if p.isSkipping, l.hasPrefix("data:") { p.skippedDataLine(); continue }
                if let m = p.feed(line: l) { out.append(m) }
            }
            T.eq(out, [.init(event: "fleet", data: ""), .init(event: "board", data: "{\"strips\":[]}")], "fleet dispatches, undecoded")
        }
        await T.suite("SSEConnection splits chunks anywhere") {
            let stream = "event: hello\ndata: {\"host\":\"studio\",\"topics\":[\"board\"]}\n\n: ping\n\nevent: turn\ndata: {\"id\":\"s1\",\"turn\":{\"role\":\"assistant\",\"text\":\"hi\",\"uuid\":\"u1\"}}\n\n"
            let bytes = Array(stream.utf8)
            for cut in [1, 3, 7, 16, bytes.count] {
                let sink = Sink()
                let c = connection(sink)
                var chunks: [Data] = []
                var i = 0
                while i < bytes.count { chunks.append(Data(bytes[i..<min(i + cut, bytes.count)])); i += cut }
                c.feedForTesting(chunks)
                T.eq(sink.messages.map(\.event), ["hello", "turn"], "chunks of \(cut)")
                T.eq(sink.messages.last?.data, #"{"id":"s1","turn":{"role":"assistant","text":"hi","uuid":"u1"}}"#)
            }
        }
        await T.suite("SSEConnection drops a skipped event's megabyte unread") {
            let sink = Sink()
            let c = connection(sink)
            let big = String(repeating: "x", count: 1_300_000)
            let stream = "event: fleet\ndata: {\"hosts\":\"\(big)\"}\n\nevent: board\ndata: {\"strips\":[],\"hosts\":[]}\n\n"
            let data = Data(stream.utf8)
            var chunks: [Data] = []
            var i = 0
            while i < data.count { chunks.append(data.subdata(in: i..<min(i + 65_536, data.count))); i += 65_536 }
            let t0 = Date()
            c.feedForTesting(chunks)
            T.eq(sink.messages.map(\.event), ["fleet", "board"])
            T.eq(sink.messages.first?.data, "", "fleet data never built")
            T.check(Date().timeIntervalSince(t0) < 1.0, "1.3 MB skipped quickly (\(Date().timeIntervalSince(t0)) s)")
        }
        await T.suite("ServerEventMapper: board, turn, manager, hello, mutation") {
            guard case .board(let b) = ServerEventMapper.map(.init(event: "board", data: BoardDecodeTests.board.replacingOccurrences(of: "\n", with: " "))) else {
                return T.fail("board event")
            }
            T.eq(b.sessions.count, 7); T.eq(b.source, .board)
            if case .unknown = ServerEventMapper.map(.init(event: "board", data: "{}")) {} else { T.fail("a board event without strips is ignored") }

            guard case .turn(let t) = ServerEventMapper.map(.init(event: "turn", data: #"{"id":"manager","host":"local","thread":"main","turn":{"id":"e1","role":"user","text":"hi","actor":"owner","thread":"main"}}"#)) else {
                return T.fail("turn")
            }
            T.eq(t.sessionId, "manager"); T.eq(t.thread, "main"); T.eq(t.turn?.id, "e1"); T.eq(t.turn?.actor, nil, "the owner is you")

            guard case .manager(let m) = ServerEventMapper.map(.init(event: "manager", data: #"{"host":"local","thread":"main","turnId":"pending:e1","inReplyTo":"e1","phase":"delta","delta":" world","text":"hello world"}"#)) else {
                return T.fail("manager")
            }
            T.eq(m, ManagerStreamEvent(host: "local", thread: "main", turnId: "pending:e1", inReplyTo: "e1", phase: .delta, delta: " world", text: "hello world"))
            if case .unknown = ServerEventMapper.map(.init(event: "manager", data: #"{"phase":"start"}"#)) {} else { T.fail("no turnId: ignored") }

            if case .hello(let host, let topics) = ServerEventMapper.map(.init(event: "hello", data: #"{"host":"studio","topics":["board"]}"#)) {
                T.eq(host, "studio"); T.check(topics, "topics honoured")
            } else { T.fail("hello") }
            if case .hello(_, let topics) = ServerEventMapper.map(.init(event: "hello", data: #"{"host":"studio"}"#)) {
                T.check(!topics, "an older daemon")
            } else { T.fail("hello") }
            if case .mutation(let op, let id) = ServerEventMapper.map(.init(event: "mutation", data: #"{"op":"sessions.answer","args":{"id":"s1","key":"1"}}"#)) {
                T.eq(op, "sessions.answer"); T.eq(id, "s1")
            } else { T.fail("mutation") }
            if case .changed(let n) = ServerEventMapper.map(.init(event: "fleet", data: "")) { T.eq(n, "fleet") } else { T.fail("fleet") }
            if case .settings = ServerEventMapper.map(.init(event: "settings", data: "{}")) {} else { T.fail("settings") }
            T.eq(ServerEventMapper.topics, ["board", "alerts", "turn", "manager", "mutation", "settings"], "the Mac app's subscription")
        }
    }
}
