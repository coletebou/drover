import Foundation

/// Mirror of the `native.summary` op result (CONTRACT.md). Decoding is lenient on purpose: missing arrays
/// become empty, unknown engines and kinds are kept as raw strings, and timestamps may be ISO 8601 strings
/// or epoch numbers (seconds or milliseconds), because the widget must never go blank on a server tweak.
struct NativeSummary: Codable, Equatable, Sendable {
    var generatedAt: Date?
    var hosts: [Host]
    var waiting: [WaitingItem]
    var working: [WorkingItem]
    var totals: Totals
    var manager: Manager?

    struct Host: Codable, Equatable, Sendable, Identifiable {
        var name: String
        var up: Bool
        var waiting: Int
        var working: Int
        var idle: Int
        var id: String { name }
    }

    struct WaitingItem: Codable, Equatable, Sendable, Identifiable {
        var id: String
        var name: String
        var host: String
        var engine: String
        var since: Date?
        var kind: String
        var headline: String

        var waitingKind: WaitingKind { WaitingKind(rawValue: kind) ?? .other }
    }

    struct WorkingItem: Codable, Equatable, Sendable, Identifiable {
        var id: String
        var name: String
        var host: String
        var engine: String
        var headline: String
    }

    struct Totals: Codable, Equatable, Sendable {
        var waiting: Int
        var working: Int
        var idle: Int
        var hosts: Int
    }

    struct Manager: Codable, Equatable, Sendable {
        var up: Bool
        var lastNoteAt: Date?
    }

    enum WaitingKind: String, Sendable {
        case decision, question, finished, other
    }
}

// MARK: - Lenient decoding

extension NativeSummary {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Lenient, but not so lenient that `{}` or an unrelated object passes for an empty fleet.
        guard c.contains(.totals) || c.contains(.hosts) else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a native.summary result"))
        }
        generatedAt = c.flexibleDate(.generatedAt)
        hosts = (try? c.decodeIfPresent([Lenient<Host>].self, forKey: .hosts))?.compactMap(\.value) ?? []
        waiting = (try? c.decodeIfPresent([Lenient<WaitingItem>].self, forKey: .waiting))?.compactMap(\.value) ?? []
        working = (try? c.decodeIfPresent([Lenient<WorkingItem>].self, forKey: .working))?.compactMap(\.value) ?? []
        totals = (try? c.decodeIfPresent(Totals.self, forKey: .totals)) ?? Totals(
            waiting: waiting.count, working: working.count,
            idle: hosts.reduce(0) { $0 + $1.idle }, hosts: hosts.count)
        manager = try? c.decodeIfPresent(Manager.self, forKey: .manager)
    }
}

extension NativeSummary.Host {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        up = (try? c.decodeIfPresent(Bool.self, forKey: .up)) ?? true
        waiting = c.flexibleInt(.waiting)
        working = c.flexibleInt(.working)
        idle = c.flexibleInt(.idle)
    }
}

extension NativeSummary.WaitingItem {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? id
        host = (try? c.decodeIfPresent(String.self, forKey: .host)) ?? ""
        engine = (try? c.decodeIfPresent(String.self, forKey: .engine)) ?? ""
        since = c.flexibleDate(.since)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "question"
        headline = (try? c.decodeIfPresent(String.self, forKey: .headline)) ?? ""
    }
}

extension NativeSummary.WorkingItem {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? id
        host = (try? c.decodeIfPresent(String.self, forKey: .host)) ?? ""
        engine = (try? c.decodeIfPresent(String.self, forKey: .engine)) ?? ""
        headline = (try? c.decodeIfPresent(String.self, forKey: .headline)) ?? ""
    }
}

extension NativeSummary.Totals {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        waiting = c.flexibleInt(.waiting)
        working = c.flexibleInt(.working)
        idle = c.flexibleInt(.idle)
        hosts = c.flexibleInt(.hosts)
    }
}

extension NativeSummary.Manager {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        up = (try? c.decodeIfPresent(Bool.self, forKey: .up)) ?? false
        lastNoteAt = c.flexibleDate(.lastNoteAt)
    }
}

/// Drops one malformed array element instead of failing the whole summary.
private struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    func flexibleInt(_ key: Key) -> Int {
        if let i = try? decodeIfPresent(Int.self, forKey: key) { return i }
        if let d = try? decodeIfPresent(Double.self, forKey: key) { return Int(d) }
        return 0
    }

    /// ISO 8601 (with or without fractional seconds) or epoch seconds / milliseconds.
    func flexibleDate(_ key: Key) -> Date? {
        if let n = try? decodeIfPresent(Double.self, forKey: key) {
            return Date(timeIntervalSince1970: n > 100_000_000_000 ? n / 1000 : n)
        }
        guard let s = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        return NativeDate.parse(s)
    }
}

enum NativeDate {
    static func parse(_ s: String) -> Date? {
        if let d = try? Date(s, strategy: .iso8601) { return d }
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let d = try? fractional.parse(s) { return d }
        if let n = Double(s) { return Date(timeIntervalSince1970: n > 100_000_000_000 ? n / 1000 : n) }
        return nil
    }
}

// MARK: - Host filter

extension NativeSummary {
    /// The summary restricted to one host (nil or empty = all hosts), with totals recomputed from that host.
    func filtered(host: String?) -> NativeSummary {
        guard let host, !host.isEmpty else { return self }
        let h = hosts.filter { $0.name == host }
        let w = waiting.filter { $0.host == host }
        let k = working.filter { $0.host == host }
        // Host counts are authoritative (the server may cap the item lists); fall back to item counts.
        let totals = h.isEmpty
            ? Totals(waiting: w.count, working: k.count, idle: 0, hosts: 0)
            : Totals(waiting: h.reduce(0) { $0 + $1.waiting }, working: h.reduce(0) { $0 + $1.working },
                     idle: h.reduce(0) { $0 + $1.idle }, hosts: h.count)
        return NativeSummary(
            generatedAt: generatedAt, hosts: h, waiting: w, working: k, totals: totals, manager: manager)
    }
}
