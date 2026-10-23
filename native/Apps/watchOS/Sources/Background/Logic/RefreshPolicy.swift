import Foundation

/// When to ask watchOS for the next background refresh.
enum RefreshPolicy {
    static let base: TimeInterval = 15 * 60
    static let afterError: TimeInterval = 30 * 60
    static let minimum: TimeInterval = 10 * 60
    static let maximum: TimeInterval = 2 * 60 * 60

    static func nextInterval(succeeded: Bool, consecutiveFailures: Int) -> TimeInterval {
        let raw: TimeInterval
        if succeeded {
            raw = base
        } else {
            let exponent = min(max(consecutiveFailures - 1, 0), 10)
            raw = min(afterError * pow(2, Double(exponent)), maximum)
        }
        return max(raw, minimum)
    }
}

/// Consecutive background failures, persisted so backoff survives relaunches.
struct RefreshFailureCounter: Sendable {
    let defaults: UserDefaults
    static let key = "drover.watch.refreshFailures"

    var count: Int {
        get { defaults.integer(forKey: Self.key) }
        nonmutating set { defaults.set(newValue, forKey: Self.key) }
    }

    func recordSuccess() { count = 0 }

    @discardableResult
    func recordFailure() -> Int {
        let n = count + 1
        count = n
        return n
    }
}

/// The local notification posted when a session starts waiting while the app is in the background.
enum NotificationContent {
    struct Payload: Equatable, Sendable {
        var identifier: String
        var title: String
        var body: String
        var link: URL
        var threadIdentifier: String
    }

    static let linkKey = "drover.link"
    static let thread = "drover.waiting"
    static let maxBody = 180

    static func make(for items: [WaitingItem]) -> Payload? {
        guard let first = items.first else { return nil }
        if items.count == 1 {
            let headline = first.headline.isEmpty ? "Waiting on you" : first.headline
            return Payload(identifier: "drover.waiting.\(first.key)", title: first.name,
                           body: truncate(headline),
                           link: DeepLink.session(id: first.id, host: first.host).url,
                           threadIdentifier: thread)
        }
        return Payload(identifier: "drover.waiting.batch", title: "\(items.count) sessions waiting on you",
                       body: truncate(items.map(\.name).joined(separator: ", ")),
                       link: DeepLink.board.url, threadIdentifier: thread)
    }

    private static func truncate(_ s: String) -> String {
        s.count <= maxBody ? s : String(s.prefix(maxBody)) + "…"
    }
}
