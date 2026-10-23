import Foundation

/// One manager thread as the chat shows it: the transcript's turns, your messages not yet confirmed, and replies
/// still streaming. Pure (harness-tested); ManagerModel feeds it the transcript, `turn` and `manager` events.
///
/// The rules (ux spec "Manager"): turns carry ids and are deduped by id; a message is echoed at once and takes the
/// event id `sessions.message` returns, so the `turn` event for it replaces the echo instead of adding a second copy;
/// a streaming reply shows the text so far, and the final reply (same id, or same `inReplyTo`) replaces it.
struct ManagerConversation: Sendable {
    struct Stream: Sendable, Equatable {
        var turnId: String
        var inReplyTo: String?
        var text: String
        var phase: ManagerStreamEvent.Phase
        var error: String?
        var startedAt: Date
    }

    /// The turns kept: as many as a read brings (LiveDroverService.managerTranscript asks for 500), so a conversation
    /// open for days (events keep coming while no view shows it) keeps its newest, and every streamed delta lays out no
    /// more than that. Echoes and streams are kept apart and never dropped.
    static let maxTurns = 500

    private(set) var thread: String
    private(set) var turns: [TranscriptTurn] = []
    /// Your messages, newest last, until the transcript or a `turn` event has them.
    private(set) var echoes: [TranscriptTurn] = []
    private(set) var streams: [String: Stream] = [:]

    init(thread: String = "main") { self.thread = thread }

    /// A reply is being written (the "working" line, the busy badge).
    var isReplying: Bool {
        streams.values.contains { $0.phase == .start || $0.phase == .delta } || turns.contains { $0.pending && $0.role == .assistant }
            || echoes.contains { $0.pending && !$0.failed }
    }

    // MARK: inputs

    /// A transcript read (a snapshot of the thread): it replaces the turns, and settles echoes and streams it covers.
    mutating func load(_ page: TranscriptPage) {
        var seen = Set<String>()
        turns = page.turns.filter { ($0.thread ?? thread) == thread && seen.insert($0.id).inserted }
        trim()
        settle()
    }

    /// You sent `text`: show it at once. Returns the echo's local id.
    @discardableResult
    mutating func echo(_ text: String, now: Date = Date()) -> String {
        let id = "local-\(UUID().uuidString)"
        echoes.append(TranscriptTurn(id: id, role: .user, text: text, ts: now, tools: [], meta: false, pending: true, thread: thread))
        return id
    }

    /// `sessions.message` answered: the echo becomes the message event (`event`), which the `turn` event will carry.
    mutating func confirm(echo localId: String, event: String?) {
        guard let i = echoes.firstIndex(where: { $0.id == localId }) else { return }
        if let event {
            if turns.contains(where: { $0.id == event }) { echoes.remove(at: i); return }
            echoes[i].id = event
        }
        echoes[i].pending = false
    }

    /// The message was not delivered.
    mutating func fail(echo localId: String, error: String) {
        guard let i = echoes.firstIndex(where: { $0.id == localId }) else { return }
        echoes[i].pending = false
        echoes[i].failed = true
        echoes.append(TranscriptTurn(id: "\(localId)-error", role: .system, text: "Not delivered: \(error)", ts: Date(),
                                     tools: [], meta: false, thread: thread, failed: true))
    }

    /// An older daemon answered inline: the reply is a turn of its own (no `turn` event will come).
    mutating func addInlineReply(_ text: String, inReplyTo: String?, now: Date = Date()) {
        let id = "reply-\(inReplyTo ?? UUID().uuidString)"
        guard !turns.contains(where: { $0.id == id }) else { return }
        // The echo becomes part of the transcript as it is.
        if let inReplyTo, let i = echoes.firstIndex(where: { $0.id == inReplyTo }) {
            var e = echoes.remove(at: i); e.pending = false
            turns.append(e)
        }
        turns.append(TranscriptTurn(id: id, role: .assistant, text: text, ts: now, tools: [], meta: false, inReplyTo: inReplyTo, thread: thread))
        trim()
    }

    /// A `turn` event for this thread.
    mutating func apply(turn: TranscriptTurn) {
        guard (turn.thread ?? thread) == thread else { return }
        // Your message, back from the daemon: it replaces its echo (by id, or by text before the id was known).
        if turn.role == .user {
            if let i = echoes.firstIndex(where: { $0.id == turn.id }) { echoes.remove(at: i) }
            else if let i = echoes.firstIndex(where: { $0.id.hasPrefix("local-") && $0.text == turn.text }) { echoes.remove(at: i) }
        } else if let r = turn.inReplyTo, let i = echoes.firstIndex(where: { $0.id == r }), !turns.contains(where: { $0.id == r }) {
            // A reply to a message whose own turn event never came (a reconnect): the message keeps its place before it.
            var e = echoes.remove(at: i); e.pending = false
            turns.append(e)
        }
        if let i = turns.firstIndex(where: { $0.id == turn.id }) { turns[i] = turn } else { turns.append(turn) }
        settle()
        trim()
    }

    /// A `manager` event: a reply streaming in.
    mutating func apply(stream e: ManagerStreamEvent, now: Date = Date()) {
        guard e.thread == thread else { return }
        // The final turn is already here (its `turn` event won the race): the stream adds nothing.
        if turns.contains(where: { ($0.id == e.turnId && !$0.pending) || (e.inReplyTo != nil && $0.inReplyTo == e.inReplyTo && Self.isFinal($0)) }) { return }
        var s = streams[e.turnId] ?? Stream(turnId: e.turnId, inReplyTo: e.inReplyTo, text: "", phase: .start, error: nil, startedAt: now)
        s.inReplyTo = s.inReplyTo ?? e.inReplyTo
        switch e.phase {
        case .start: break
        case .delta: s.text = e.text ?? (s.text + (e.delta ?? ""))
        case .done: s.text = e.text ?? s.text
        case .error: s.error = e.error ?? "the manager could not answer"
        }
        s.phase = e.phase
        streams[e.turnId] = s
    }

    /// A reply, or the system turn that says the manager did not answer.
    static func isFinal(_ t: TranscriptTurn) -> Bool {
        (t.role == .assistant && !t.pending) || (t.role == .system && t.inReplyTo != nil)
    }

    /// The newest `maxTurns` turns.
    private mutating func trim() {
        if turns.count > Self.maxTurns { turns.removeFirst(turns.count - Self.maxTurns) }
    }

    /// Drop streams and pending turns a final reply covers, and echoes the transcript has.
    private mutating func settle() {
        let finals = turns.filter(Self.isFinal)
        let answered = Set(finals.compactMap(\.inReplyTo))
        let finalIds = Set(finals.map(\.id))
        streams = streams.filter { id, s in !finalIds.contains(id) && !(s.inReplyTo.map(answered.contains) ?? false) }
        turns.removeAll { $0.pending && $0.role == .assistant && ($0.inReplyTo.map(answered.contains) ?? false) && !finalIds.contains($0.id) }
        let ids = Set(turns.map(\.id))
        echoes.removeAll { ids.contains($0.id) }
    }

    // MARK: output

    /// What the chat shows: the turns, then unconfirmed messages, with each streaming reply after the message it answers.
    var display: [TranscriptTurn] {
        // A pending turn from a transcript read shows the newest text its stream has.
        var out = turns.map { t -> TranscriptTurn in
            guard t.pending, let s = streams[t.id], s.text.count >= t.text.count else { return t }
            var u = t; u.text = s.text; u.pending = s.phase == .start || s.phase == .delta
            return u
        } + echoes
        let present = Set(out.map(\.id))
        for s in streams.values.sorted(by: { $0.startedAt < $1.startedAt }) where !present.contains(s.turnId) {
            let failed = s.phase == .error
            let turn = TranscriptTurn(id: s.turnId, role: .assistant, text: failed ? "The manager could not answer: \(s.error ?? "")" : s.text,
                                      ts: s.startedAt, tools: [], meta: false, pending: s.phase == .start || s.phase == .delta,
                                      inReplyTo: s.inReplyTo, thread: thread, failed: failed)
            if let r = s.inReplyTo, let i = out.lastIndex(where: { $0.id == r }) { out.insert(turn, at: i + 1) }
            else { out.append(turn) }
        }
        return out
    }
}
