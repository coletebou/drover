import Foundation
import os

/// Talks to the Drover daemon over HTTP + SSE (CONTRACT.md "Transport", ux spec "Daemon API").
///
/// Requests and JSON decoding never run on the main actor: the calls that decode are `@concurrent` (the global
/// executor even where nonisolated async functions run on their caller's actor, NonisolatedNonsendingByDefault), and
/// the SSE stream is read and decoded on its own queue (SSEConnection).
///
/// Shim until DroverKit merges: a small URLSession client of its own. Swap plan: keep this type and its
/// DroverService conformance, replace `call` with DroverClient and `events` with DroverKit's EventStream.
final class LiveDroverService: DroverService, @unchecked Sendable {
    private let baseURL: URL?
    /// Read once: endpoint and credential are bound together for this instance's lifetime, so a request
    /// still in flight after Settings changes can never carry the new token to the old server.
    /// AppModel.reconfigure() builds a fresh instance after any URL or token change.
    private let token: String?
    private let session: URLSession
    private let opsCache = OpsCache()
    private let caps = Capabilities()

    /// Requests idle longer than this fail (> native.notifications' 25 s long poll).
    static let defaultTimeout: TimeInterval = 40
    /// A daemon that predates `wait: false` holds sessions.message to the manager until the reply (up to 15 min).
    static let managerTimeout: TimeInterval = 16 * 60

    init(baseURL: URL?, tokens: TokenStore, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = tokens.read()
        self.session = session
    }

    // MARK: transport

    /// POST /api/op/<op> with JSON args. Returns `result` or throws.
    @concurrent
    func call(_ op: String, _ args: [String: JSONValue] = [:], timeout: TimeInterval = LiveDroverService.defaultTimeout) async throws -> JSONValue {
        #if DROVER_DEV
        if DevConfig.mutatingOps.contains(op) && !DevConfig.allowsWrites(to: baseURL) {
            throw DroverError.server("The dev build does not write to this daemon (\(op)). Point it at the test daemon, or set DROVER_DEV_ALLOW_WRITES=1.")
        }
        #endif
        var req = try request(path: "api/op/\(op)", method: "POST", body: try JSONEncoder().encode(JSONValue.object(args)))
        req.timeoutInterval = timeout
        let (data, resp) = try await session.data(for: req)
        let t0 = PerfLog.now()
        let r = try Self.unwrap(data: data, response: resp)
        if data.count > 50_000 { PerfLog.log("decode \(op)", since: t0, "\(data.count / 1024) KB, main thread: \(pthread_main_np() != 0)") }
        return r
    }

    static func unwrap(data: Data, response: URLResponse) throws -> JSONValue {
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = try? JSONValue.parse(data)
        if code == 401 { throw DroverError.unauthorized }
        guard let json else { throw DroverError.http(code, nil) }
        if json["ok"]?.bool == false || !(200..<300).contains(code) {
            let msg = json["error"]?.text
            if code >= 300 && msg == nil { throw DroverError.http(code, nil) }
            throw DroverError.server(msg ?? "request failed")
        }
        return json["result"] ?? .null
    }

    private func request(path: String, method: String, query: [URLQueryItem] = [], body: Data? = nil) throws -> URLRequest {
        guard let baseURL, let token else { throw DroverError.notConfigured }
        var url = baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        req.timeoutInterval = Self.defaultTimeout
        return req
    }

    /// Host arg for an op: omit for the local machine (the daemon also accepts its own short name).
    private func hostArg(_ host: String?, into args: inout [String: JSONValue]) {
        if let host, !host.isEmpty && host != "local" { args["host"] = .string(host) }
    }

    // MARK: board

    @concurrent
    func board() async throws -> BoardSnapshot {
        if await caps.tryBoardOp() {
            let t0 = PerfLog.now()
            do {
                let r = try await call("native.board")
                await caps.set(boardOp: true)
                let snap = BoardDecoder.snapshot(r)
                PerfLog.log("board native.board", since: t0, "\(snap.sessions.count) strips, main thread: \(pthread_main_np() != 0)")
                return snap
            } catch let e as DroverError where e.isUnknownOp {
                // An older daemon: the fleet fallback, and native.board again in a few minutes (it may update).
                await caps.set(boardOp: false)
            }
        }
        let t0 = PerfLog.now()
        async let fleet = call("fleet.summary")
        // native.summary is added by window 0; older daemons answer "unknown op", which is fine.
        let native = try? await call("native.summary")
        var snapshot = BoardBuilder.build(fleet: try await fleet, native: native)
        if let native {
            Owner.remember(summary: native)
            snapshot.nativeSummaryJSON = try? JSONEncoder().encode(native)
        }
        PerfLog.log("board fleet fallback", since: t0, "\(snapshot.sessions.count) sessions")
        return snapshot
    }

    /// Widgets read `native.summary` from the App Group; with native.board doing the board, it is fetched on its own.
    /// It also names the owner (`Owner`).
    func nativeSummaryJSON() async -> Data? {
        guard let native = try? await call("native.summary") else { return nil }
        Owner.remember(summary: native)
        return try? JSONEncoder().encode(native)
    }

    // MARK: transcripts

    /// A Claude transcript's first read: the newest turns (a tool call is about three of them).
    static let claudePage = 300

    @concurrent
    func transcript(of session: SessionItem, since: Int?, limit: Int?) async throws -> TranscriptPage {
        if session.isManager { return try await managerTranscript(thread: "main", host: session.host) }
        // Claude reads are incremental. Other engines return snapshots and are re-read whole.
        let limit = limit ?? (session.engine == "claude" ? Self.claudePage : 500)
        var args: [String: JSONValue] = ["id": .string(session.transcriptId), "limit": .number(Double(limit))]
        if let since { args["since"] = .number(Double(since)) }
        hostArg(session.host, into: &args)
        let t0 = PerfLog.now()
        let page = TranscriptMapper.page(try await call("sessions.transcript", args))
        PerfLog.log("transcript \(since == nil ? "full" : "since")", since: t0, "\(page.turns.count) turns")
        return page
    }

    func capture(target: String, host: String, lines: Int) async throws -> ScreenCapture {
        var args: [String: JSONValue] = ["target": .string(target), "lines": .number(Double(lines))]
        hostArg(host, into: &args)
        let r = try await call("tmux.capture", args)
        return ScreenCapture(target: r["target"]?.text ?? target, text: r["text"]?.string ?? "",
                             state: r["screen"]?["state"]?.text.flatMap(ScreenState.init(rawValue:)) ?? .unknown,
                             reason: r["screen"]?["reason"]?.text, dialog: BoardDecoder.dialogInfo(r["dialog"]),
                             hash: r["hash"]?.text, keys: r["keys"]?.strings ?? [])
    }

    func follow(id: String, host: String, on: Bool) async {
        var body: [String: JSONValue] = ["id": .string(id), "on": .bool(on)]
        hostArg(host, into: &body)
        guard var req = try? request(path: "api/follow", method: "POST", body: try? JSONEncoder().encode(JSONValue.object(body))) else { return }
        req.timeoutInterval = 15
        _ = try? await session.data(for: req)
    }

    // MARK: messages and keys

    func sendMessage(to session: SessionItem, text: String) async throws -> MessageResult {
        if session.isManager { return try await messageManager(text: text, thread: "main", host: session.host) }
        var args: [String: JSONValue] = ["id": .string(session.transcriptId), "text": .string(text), "actor": .string(Owner.alias)]
        hostArg(session.host, into: &args)
        let r = try await call("sessions.message", args)
        return MessageResult(queuedBehindTurn: r["queuedBehindTurn"]?.bool ?? false, reply: r["reply"]?.text)
    }

    func sendToPane(target: String, host: String, text: String, enter: Bool, force: Bool) async throws -> PaneSendResult {
        var args: [String: JSONValue] = ["target": .string(target), "text": .string(text), "enter": .bool(enter),
                                         "force": .bool(force), "actor": .string(Owner.alias)]
        hostArg(host, into: &args)
        let r = try await call("tmux.send", args)
        return PaneSendResult(refused: r["refused"]?.bool ?? false, reason: r["reason"]?.text ?? r["screen"]?["reason"]?.text)
    }

    func sendKeys(target: String, host: String, keys: [PaneKey]) async throws {
        var args: [String: JSONValue] = ["target": .string(target), "keys": .array(keys.map { .string($0.rawValue) })]
        hostArg(host, into: &args)
        _ = try await call("tmux.keys", args)
    }

    func answer(id: String, host: String, target: String?, key: String, expect: String?) async throws -> AnswerResult {
        var args: [String: JSONValue] = ["id": .string(id), "key": .string(key), "actor": .string(Owner.alias)]
        if let expect { args["expect"] = .string(expect) }
        hostArg(host, into: &args)
        if await caps.answerOp != false {
            do {
                let r = try await call("sessions.answer", args)
                await caps.set(answerOp: true)
                return Self.answerResult(r)
            } catch let e as DroverError where e.isUnknownOp {
                await caps.set(answerOp: false)
            } catch DroverError.server(let m) where target != nil && m.localizedCaseInsensitiveContains("session not found") {
                // A session the daemon cannot map to a window (not Claude's registry): the window itself.
            }
        }
        // A daemon from before sessions.answer: tmux.answer on the window, with the same screen check.
        guard let target else { throw DroverError.server("This session has no tmux pane. Reply with a message instead.") }
        var legacy: [String: JSONValue] = ["target": .string(target), "key": .string(key), "actor": .string(Owner.alias)]
        if let expect { legacy["expect"] = .string(expect) }
        hostArg(host, into: &legacy)
        return Self.answerResult(try await call("tmux.answer", legacy))
    }

    static func answerResult(_ r: JSONValue) -> AnswerResult {
        let refused = r["refused"]?.bool ?? (r["ok"]?.bool == false)
        return AnswerResult(ok: !refused && r["ok"]?.bool != false, refused: refused, reason: r["reason"]?.text,
                            hash: r["hash"]?.text, dialog: BoardDecoder.dialogInfo(r["dialog"]), keys: r["keys"]?.strings ?? [])
    }

    // MARK: manager

    @concurrent
    func managerTranscript(thread: String, host: String?) async throws -> TranscriptPage {
        // A daemon from before threads returns the FIRST `limit` turns of its 500-turn buffer: ask for all of it.
        var args: [String: JSONValue] = ["id": "manager", "limit": 500]
        if thread != "main" { args["thread"] = .string(thread) }
        hostArg(host, into: &args)
        var page = TranscriptMapper.page(try await call("sessions.transcript", args))
        page.incremental = false
        return page
    }

    func messageManager(text: String, thread: String, host: String?) async throws -> MessageResult {
        var args: [String: JSONValue] = ["id": "manager", "text": .string(text), "actor": .string(Owner.alias), "wait": false]
        if thread != "main" { args["thread"] = .string(thread) }
        hostArg(host, into: &args)
        // No 40 s idle timeout: an older daemon ignores wait: false and answers only when the manager has.
        let r = try await call("sessions.message", args, timeout: Self.managerTimeout)
        return MessageResult(queuedBehindTurn: false, reply: r["reply"]?.string, pending: r["pending"]?.bool ?? false,
                             event: r["event"]?.text, turnId: r["turnId"]?.text, thread: r["thread"]?.text)
    }

    func managerThreads(host: String?) async throws -> [ManagerThread] {
        var args: [String: JSONValue] = [:]
        hostArg(host, into: &args)
        let r: JSONValue
        do { r = try await call("openclaw.threads", args) }
        catch let e as DroverError where e.isUnknownOp { throw DroverError.unsupported("openclaw.threads") }
        let list = r.array.isEmpty ? (r["threads"]?.array ?? []) : r.array
        return list.compactMap { t in
            guard let name = t["thread"]?.text else { return nil }
            return ManagerThread(thread: name, turns: t["turns"]?.int ?? 0, lastAt: t["lastTs"]?.date, lastText: t["lastText"]?.text)
        }
    }

    func sweep(host: String?) async throws -> String {
        var args: [String: JSONValue] = [:]
        hostArg(host, into: &args)
        let r = try await call("openclaw.sweep", args, timeout: 120)
        return r["queued"]?.text.map { "Sweep queued: \($0)" } ?? "Sweep queued"
    }

    // MARK: uploads, notifications, ping

    func supportsUploads() async -> Bool {
        if let known = await opsCache.ops { return known.contains("uploads.put") }
        guard let req = try? request(path: "api/ops", method: "GET"),
              let (data, _) = try? await session.data(for: req),
              let json = try? JSONValue.parse(data) else { return false }
        // { ops: { "<name>": meta } } or { ops: [ "<name>" | { name } ] }
        let names: Set<String> = json["ops"]?.object.map { Set($0.keys) }
            ?? Set(json["ops"]?.array.compactMap { $0["name"]?.text ?? $0.text } ?? [])
        await opsCache.set(names)
        return names.contains("uploads.put")
    }

    func upload(for session: SessionItem, fileName: String, mime: String, data: Data) async throws -> String {
        guard await supportsUploads() else { throw DroverError.unsupported("Uploads") }
        var args: [String: JSONValue] = ["session": .string(session.transcriptId), "name": .string(fileName), "mime": .string(mime),
                                         "data": .string(data.base64EncodedString()), "actor": .string(Owner.alias)]
        hostArg(session.host, into: &args)
        let r = try await call("uploads.put", args)
        guard let path = r["path"]?.text else { throw DroverError.decoding("uploads.put returned no path") }
        return path
    }

    func notifications(since cursor: String?, wait: Int) async throws -> NotificationPage {
        var args: [String: JSONValue] = ["wait": .number(Double(min(max(wait, 0), 25)))]
        if let cursor { args["since"] = .string(cursor) }
        let r: JSONValue
        do { r = try await call("native.notifications", args) }
        catch let e as DroverError where e.isUnknownOp { throw DroverError.unsupported("native.notifications") }
        return NotificationPage(cursor: r["cursor"]?.string, items: r["items"]?.array.compactMap(ServerEventMapper.notifyItem) ?? [])
    }

    func ping() async throws -> String {
        try await call("host.identity")["host"]?.text ?? "drover"
    }

    // MARK: events

    func events(onState: @escaping @Sendable (ConnectionState) -> Void) -> AsyncStream<ServerEvent> {
        AsyncStream { continuation in
            let task = Task { [weak self] in
                var attempt = 0
                // The daemon serves GET /api/stream (CONTRACT.md "SSE path"); /api/events is the documented fallback.
                var paths = ["api/stream", "api/events"]
                while !Task.isCancelled, let self {
                    let opened = OSAllocatedUnfairLock(initialState: false)
                    do {
                        var req = try self.request(path: paths[0], method: "GET",
                                                   query: [URLQueryItem(name: "topics", value: ServerEventMapper.topics.joined(separator: ","))])
                        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        req.timeoutInterval = 75
                        onState(attempt == 0 ? .connecting : .reconnecting(attempt: attempt))
                        let connection = SSEConnection(
                            skipData: ServerEventMapper.skipData,
                            onOpen: { opened.withLock { $0 = true }; onState(.live) },
                            onMessage: { continuation.yield(ServerEventMapper.map($0)) })
                        // The daemon pings every 20 s; 75 s of silence is a dead connection.
                        try await connection.run(req, idleTimeout: 75)
                    } catch is CancellationError {
                        break
                    } catch SSEConnection.Failure.status(404) where paths.count > 1 {
                        paths.removeFirst()
                        continue
                    } catch DroverError.notConfigured {
                        onState(.notConfigured)
                        try? await Task.sleep(for: .seconds(5))
                        continue
                    } catch {
                        if Task.isCancelled { break }
                        onState(.failed(error.localizedDescription))
                    }
                    if opened.withLock({ $0 }) { attempt = 0 }
                    attempt += 1
                    // 1, 2, 4, 8, 16, 30, 30 ... seconds, with jitter.
                    let delay = min(30.0, pow(2.0, Double(min(attempt - 1, 5)))) * Double.random(in: 0.8...1.2)
                    try? await Task.sleep(for: .seconds(delay))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private actor OpsCache {
    var ops: Set<String>?
    func set(_ o: Set<String>) { ops = o }
}

/// What this daemon answers to, learnt from "unknown op" replies. `native.board` is tried again every ten minutes:
/// the daemon may have been updated meanwhile.
private actor Capabilities {
    private var boardOp: Bool?
    private var boardRetryAt = Date.distantPast
    private(set) var answerOp: Bool?

    func tryBoardOp() -> Bool { boardOp != false || Date() >= boardRetryAt }
    func set(boardOp: Bool) {
        self.boardOp = boardOp
        if !boardOp { boardRetryAt = Date().addingTimeInterval(600) }
    }
    func set(answerOp: Bool) { self.answerOp = answerOp }
}
