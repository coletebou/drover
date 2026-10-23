import Foundation

/// Pure transcript merge rules for the chat view (no UI, testable with plain swiftc).
enum ChatMerge {
    static let maxTurns = 500
    static let pageLimit = 200

    /// Claude offsets are byte offsets, so only Claude can be read incrementally. Codex returns offset 0
    /// and the full list; openclaw offsets are turn counts; headless agents (any engine) answer a rolling
    /// snapshot. Those are re-fetched in full.
    static func isIncremental(engine: Engine?, offset: Int, headless: Bool = false) -> Bool {
        engine == .claude && !headless && offset > 0
    }

    /// The `since` argument for the next fetch (nil = full re-fetch).
    static func since(engine: Engine?, offset: Int, headless: Bool = false) -> Int? {
        isIncremental(engine: engine, offset: offset, headless: headless) ? offset : nil
    }

    /// Appends `new` to `existing`, dropping turns whose id is already present, then caps to `maxTurns` (newest kept).
    static func append(_ existing: [Turn], _ new: [Turn]) -> [Turn] {
        var seen = Set(existing.map(\.id))
        var out = existing
        for t in new where seen.insert(t.id).inserted { out.append(t) }
        return cap(out)
    }

    static func cap(_ turns: [Turn]) -> [Turn] {
        turns.count > maxTurns ? Array(turns.suffix(maxTurns)) : turns
    }

    /// Applies a fetched page. `usedSince` says whether the request was incremental.
    static func apply(page: TranscriptPage, to existing: [Turn], usedSince: Bool) -> [Turn] {
        usedSince ? append(existing, page.turns) : cap(dedupe(page.turns))
    }

    static func dedupe(_ turns: [Turn]) -> [Turn] {
        var seen = Set<String>()
        return turns.filter { seen.insert($0.id).inserted }
    }

    /// Turns the chat shows: user turns with meta are skipped, and empty turns (except thinking).
    static func isVisible(_ t: Turn) -> Bool {
        if t.role == "user", t.meta == true { return false }
        if t.role == "thinking" { return true }
        return !(t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func visible(_ turns: [Turn]) -> [Turn] { turns.filter(isVisible) }

    /// Plain-text export: "user: ...\nassistant: ..." for user and assistant turns.
    static func plainText(_ turns: [Turn]) -> String {
        visible(turns).compactMap { t -> String? in
            guard t.role == "user" || t.role == "assistant" else { return nil }
            return "\(t.role): \((t.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines))"
        }.joined(separator: "\n")
    }
}

/// A message the user just sent that the transcript has not echoed back yet.
struct ChatPending: Identifiable, Hashable, Sendable {
    enum Status: Hashable, Sendable { case sending, sent, queued }
    let id: UUID
    var text: String
    var status: Status
    var createdAt: Date

    init(id: UUID = UUID(), text: String, status: Status = .sending, createdAt: Date = Date()) {
        self.id = id; self.text = text; self.status = status; self.createdAt = createdAt
    }

    var statusLabel: String {
        switch status {
        case .sending: "Sending"
        case .sent: "Sent"
        case .queued: "Queued: the session is busy and reads this after its turn"
        }
    }

    /// Drops pending messages whose text now appears as a user turn. Messages still being sent are kept.
    static func reconcile(_ pending: [ChatPending], with turns: [Turn]) -> [ChatPending] {
        let sent = Set(turns.filter { $0.role == "user" }.map { normalize($0.text ?? "") })
        return pending.filter { p in
            p.status == .sending || !sent.contains(normalize(p.text))
        }
    }

    static func normalize(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
