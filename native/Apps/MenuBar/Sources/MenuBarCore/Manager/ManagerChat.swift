import Foundation

// The menu bar's view of the manager conversation: the last exchange (a question and its reply), the reply
// streaming in from SSE `manager` events and settled by `turn` events. Pure: the store feeds it the send
// result, the stream and the transcript, and the tests drive it the same way.

/// SSE `manager`: `{ host, thread, turnId, inReplyTo, phase: start|delta|done|error, delta?, text?, error? }`.
/// `text` is the reply so far (`delta` the new part); `done` carries the whole reply.
struct ManagerStreamEvent: Decodable, Sendable, Equatable {
    var host: String?
    var thread: String?
    var turnId: String?
    var inReplyTo: String?
    var phase: String
    var delta: String?
    var text: String?
    var error: String?

    init(host: String? = nil, thread: String? = nil, turnId: String? = nil, inReplyTo: String? = nil, phase: String,
         delta: String? = nil, text: String? = nil, error: String? = nil) {
        self.host = host; self.thread = thread; self.turnId = turnId; self.inReplyTo = inReplyTo
        self.phase = phase; self.delta = delta; self.text = text; self.error = error
    }
}

/// A transcript turn as `sessions.transcript` and SSE `turn` carry it (only the fields the menu bar reads).
struct TranscriptTurn: Decodable, Sendable, Equatable {
    var id: String?
    var uuid: String?
    var role: String
    var text: String?
    var ts: String?
    var thread: String?
    var pending: Bool?
    var actor: String?
    /// Older daemons: `drover:<actor>` on manager user turns.
    var user: String?
    var inReplyTo: String?
    var turnId: String?

    init(id: String? = nil, role: String, text: String?, ts: String? = nil, thread: String? = nil, pending: Bool? = nil,
         actor: String? = nil, inReplyTo: String? = nil, turnId: String? = nil) {
        self.id = id; self.role = role; self.text = text; self.ts = ts; self.thread = thread; self.pending = pending
        self.actor = actor; self.inReplyTo = inReplyTo; self.turnId = turnId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = (try? c.decode(String.self, forKey: .role)) ?? "system"
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        uuid = try? c.decodeIfPresent(String.self, forKey: .uuid)
        text = try? c.decodeIfPresent(String.self, forKey: .text)
        ts = try? c.decodeIfPresent(String.self, forKey: .ts)
        thread = try? c.decodeIfPresent(String.self, forKey: .thread)
        pending = try? c.decodeIfPresent(Bool.self, forKey: .pending)
        actor = try? c.decodeIfPresent(String.self, forKey: .actor)
        user = try? c.decodeIfPresent(String.self, forKey: .user)
        inReplyTo = try? c.decodeIfPresent(String.self, forKey: .inReplyTo)
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
    }

    private enum CodingKeys: String, CodingKey { case id, uuid, role, text, ts, thread, pending, actor, user, inReplyTo, turnId }

    /// Who wrote a user turn (`mcp`, a bot, the owner's configured name); nil for no one named or the generic owner
    /// actor. `MenuBarStore.asker` also reads the configured name as the owner.
    var askedBy: String? {
        let who = actor ?? user.map { $0.hasPrefix("drover:") ? String($0.dropFirst(7)) : $0 }
        guard let who, !who.isEmpty, !AppIdentifiers.isOwner(who, owner: nil) else { return nil }
        return who
    }
}

/// SSE `turn`: `{ id, host?, thread?, turn }` (for the manager, every user message and reply).
struct TurnEvent: Decodable, Sendable {
    var id: String
    var host: String?
    var thread: String?
    var turn: TranscriptTurn
}

/// `sessions.transcript` result (only the turns).
struct TranscriptPage: Decodable, Sendable {
    var turns: [TranscriptTurn]
    var offset: Int?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        turns = ((try? c.decodeIfPresent([Lossy<TranscriptTurn>].self, forKey: .turns)) ?? []).compactMap(\.value)
        offset = try? c.decodeIfPresent(Int.self, forKey: .offset)
    }

    private enum CodingKeys: String, CodingKey { case turns, offset }
}

/// `sessions.message` to the manager. New daemons with `wait: false`: `{ok, pending: true, event, turnId,
/// thread}`; older ones block and answer `{ok, reply, event}`.
struct ManagerSendResult: Decodable, Sendable, Equatable {
    var pending: Bool?
    var event: String?
    var turnId: String?
    var thread: String?
    var reply: String?

    init(pending: Bool? = nil, event: String? = nil, turnId: String? = nil, thread: String? = nil, reply: String? = nil) {
        self.pending = pending; self.event = event; self.turnId = turnId; self.thread = thread; self.reply = reply
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pending = try? c.decodeIfPresent(Bool.self, forKey: .pending)
        event = try? c.decodeIfPresent(String.self, forKey: .event)
        turnId = try? c.decodeIfPresent(String.self, forKey: .turnId)
        thread = try? c.decodeIfPresent(String.self, forKey: .thread)
        reply = try? c.decodeIfPresent(String.self, forKey: .reply)
    }

    private enum CodingKeys: String, CodingKey { case pending, event, turnId, thread, reply }
}

struct ManagerQuestion: Sendable, Equatable {
    /// The truth-file event id; nil while it is only the local echo.
    var id: String?
    var text: String
    /// Who asked, when not the generic owner actor (`TranscriptTurn.askedBy`).
    var askedBy: String?
}

struct ManagerReply: Sendable, Equatable {
    enum Phase: Sendable, Equatable {
        /// Sent, nothing streamed yet.
        case waiting
        case streaming
        case done
        case failed(String)
    }

    var turnId: String?
    var inReplyTo: String?
    var text: String
    var phase: Phase

    var inFlight: Bool { phase == .waiting || phase == .streaming }
}

struct ManagerChat: Sendable, Equatable {
    var question: ManagerQuestion?
    var reply: ManagerReply?
    /// The POST is in flight.
    var sending = false

    /// A reply is being written (or the message is still on its way).
    var busy: Bool { sending || reply?.inFlight == true }
    var isEmpty: Bool { question == nil && reply == nil }

    static let mainThread = "main"

    /// Only the shared conversation shows here; a window's own manager thread does not.
    static func isMainThread(_ thread: String?) -> Bool { thread == nil || thread == "" || thread == mainThread }

    // MARK: Sending

    mutating func beginSend(_ text: String) {
        question = ManagerQuestion(id: nil, text: text, askedBy: nil)
        reply = ManagerReply(turnId: nil, inReplyTo: nil, text: "", phase: .waiting)
        sending = true
    }

    mutating func sent(_ result: ManagerSendResult) {
        sending = false
        if let event = result.event, question?.id == nil { question?.id = event }
        if let text = result.reply {
            // A daemon from before wait:false answered inside the call.
            if reply?.phase != .done { reply = ManagerReply(turnId: result.turnId, inReplyTo: question?.id, text: text, phase: .done) }
            return
        }
        if reply == nil { reply = ManagerReply(turnId: result.turnId, inReplyTo: question?.id, text: "", phase: .waiting) }
        if reply?.turnId == nil { reply?.turnId = result.turnId }
        if reply?.inReplyTo == nil { reply?.inReplyTo = question?.id }
    }

    mutating func sendFailed(_ message: String) {
        sending = false
        reply = ManagerReply(turnId: nil, inReplyTo: question?.id, text: reply?.text ?? "", phase: .failed(message))
    }

    // MARK: Stream

    /// Does a streamed or settled reply belong to the exchange on show? The question's event id (`inReplyTo`)
    /// decides when both sides know it, then the reply's turn id; with neither (the stream raced the POST
    /// answer), the reply in flight takes it.
    private func belongs(turnId: String?, inReplyTo: String?) -> Bool {
        guard let reply else {
            guard let q = question else { return false }
            return inReplyTo == nil || q.id == nil || q.id == inReplyTo
        }
        if let inReplyTo, let asked = reply.inReplyTo ?? question?.id { return inReplyTo == asked }
        if let turnId, let mine = reply.turnId, turnId == mine { return true }
        return reply.inFlight
    }

    /// Someone else's question is being answered (another client asked): that exchange goes on show.
    private mutating func startOther(turnId: String?, inReplyTo: String?) {
        if !(inReplyTo != nil && question?.id == inReplyTo) { question = nil }
        reply = ManagerReply(turnId: turnId, inReplyTo: inReplyTo, text: "", phase: .streaming)
    }

    mutating func apply(_ e: ManagerStreamEvent) {
        guard Self.isMainThread(e.thread) else { return }
        if !belongs(turnId: e.turnId, inReplyTo: e.inReplyTo) {
            guard ["start", "delta", "done"].contains(e.phase) else { return }
            startOther(turnId: e.turnId, inReplyTo: e.inReplyTo)
        }
        var r = reply ?? ManagerReply(turnId: e.turnId, inReplyTo: e.inReplyTo, text: "", phase: .streaming)
        if r.turnId == nil { r.turnId = e.turnId }
        if r.inReplyTo == nil { r.inReplyTo = e.inReplyTo }
        switch e.phase {
        case "start":
            if r.phase != .done {
                r.phase = .streaming
                if let text = e.text { r.text = text }
            }
        case "delta":
            guard r.phase != .done else { break }
            r.phase = .streaming
            if let text = e.text { r.text = text } else if let delta = e.delta { r.text += delta }
        case "done":
            if let text = e.text { r.text = text }
            r.phase = .done
        case "error":
            r.phase = .failed(e.error?.isEmpty == false ? e.error! : "The manager did not answer.")
        default:
            return
        }
        reply = r
    }

    mutating func apply(turn: TranscriptTurn) {
        guard Self.isMainThread(turn.thread) else { return }
        let text = (turn.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch turn.role {
        case "user":
            guard !text.isEmpty else { return }
            if let id = turn.id, question?.id == id { question?.text = text; return }
            if let q = question, q.id == nil, q.text.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                // The server copy of the local echo.
                question?.id = turn.id
                if reply?.inReplyTo == nil { reply?.inReplyTo = turn.id }
                return
            }
            question = ManagerQuestion(id: turn.id, text: text, askedBy: turn.askedBy)
            reply = nil
        case "assistant":
            let turnId = turn.turnId ?? turn.id
            if !belongs(turnId: turnId, inReplyTo: turn.inReplyTo) { startOther(turnId: turnId, inReplyTo: turn.inReplyTo) }
            var r = reply ?? ManagerReply(turnId: turnId, inReplyTo: turn.inReplyTo, text: "", phase: .streaming)
            if r.turnId == nil { r.turnId = turnId }
            if turn.pending == true {
                guard r.phase != .done else { return }
                r.phase = .streaming
                if !text.isEmpty { r.text = turn.text ?? r.text }
            } else {
                r.text = turn.text ?? r.text
                r.phase = .done
            }
            reply = r
        case "system":
            // "delivery failed: ..." from the daemon.
            if reply?.inFlight == true, !text.isEmpty { reply?.phase = .failed(text) }
        default:
            return
        }
    }

    // MARK: History

    /// The last exchange of a transcript page (main thread): the last question and the reply after it.
    mutating func seed(_ turns: [TranscriptTurn]) {
        let main = turns.filter { Self.isMainThread($0.thread) && ($0.role == "user" || $0.role == "assistant") }
        guard !main.isEmpty else { return }
        // A conversation already on show (sent from here, or streamed) is newer than any history page.
        guard question == nil, reply == nil else { return }
        if let qi = main.lastIndex(where: { $0.role == "user" && !($0.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
            let q = main[qi]
            question = ManagerQuestion(id: q.id, text: (q.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines), askedBy: q.askedBy)
            if let a = main[(qi + 1)...].first(where: { $0.role == "assistant" }) {
                reply = ManagerReply(turnId: a.turnId ?? a.id, inReplyTo: q.id, text: a.text ?? "",
                                     phase: a.pending == true ? .streaming : .done)
            }
        } else if let a = main.last {
            reply = ManagerReply(turnId: a.turnId ?? a.id, inReplyTo: nil, text: a.text ?? "", phase: a.pending == true ? .streaming : .done)
        }
    }

    /// A transcript page read while a reply is due and no stream delivers it: from the question on show
    /// (by id, else by its text) every turn applies in order, so the reply advances or settles, and a newer
    /// question someone else asked takes over. With nothing on show it seeds.
    mutating func catchUp(_ turns: [TranscriptTurn]) {
        guard let q = question else {
            if reply == nil { seed(turns) }
            return
        }
        let main = turns.filter { Self.isMainThread($0.thread) }
        let asked = q.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let start = main.lastIndex { t in
            guard t.role == "user" else { return false }
            if let id = q.id { return t.id == id }
            return (t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == asked
        }
        guard let start else { return }
        for t in main[start...] { apply(turn: t) }
    }
}
