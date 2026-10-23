import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A scripted daemon for pairing tests and previews: answers in order (the last answer repeats) and records every
/// request. Never touches the network. Canned answers below follow the daemon's shapes.
public final class MockPairingTransport: PairingTransport, @unchecked Sendable {
    public enum Answer: Sendable {
        case http(status: Int, body: String, headers: [String: String])
        /// No answer, as when the daemon is not running.
        case unreachable
        /// Never answers (until the task is cancelled).
        case hang
        /// `answer` after `delay`, even when the request is cancelled meanwhile: a reply already on the wire.
        indirect case late(Answer, after: Duration)
    }

    private let lock = NSLock()
    private var answers: [Answer]
    private var recorded: [URLRequest] = []

    public init(_ answers: [Answer]) {
        self.answers = answers
    }

    /// Every request so far, oldest first.
    public var requests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await reply(take(request), to: request)
    }

    private func reply(_ answer: Answer, to request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        switch answer {
        case .late(let answer, let delay):
            await Task.detached { try? await Task.sleep(for: delay) }.value   // not cancelled with the caller
            return try await reply(answer, to: request)
        case .http(let status, let body, let headers):
            let url = request.url ?? URL(string: "http://drover.mock")!
            guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
                throw URLError(.badServerResponse)
            }
            return (Data(body.utf8), response)
        case .unreachable:
            throw URLError(.cannotConnectToHost)
        case .hang:
            try await Task.sleep(for: .seconds(24 * 3600))
            throw CancellationError()
        }
    }

    private func take(_ request: URLRequest) -> Answer {
        lock.lock(); defer { lock.unlock() }
        recorded.append(request)
        if answers.count > 1 { return answers.removeFirst() }
        return answers.first ?? .hang
    }

    // MARK: canned answers

    public static let requestId = "0123456789abcdef0123456789abcdef"

    /// 201 from `POST /api/pair/request`. `date`: the daemon's `Date` header, if any.
    public static func created(code: String = "123456", expiresAt: String, pollMs: Double = 1500,
                               requestId: String = requestId, date: String? = nil) -> Answer {
        json(201, ["requestId": .string(requestId), "code": .string(code), "expiresAt": .string(expiresAt), "pollMs": .number(pollMs)],
             date: date)
    }

    public static func pending(expiresAt: String? = nil) -> Answer {
        var body: [String: JSONValue] = ["status": .string("pending")]
        if let expiresAt { body["expiresAt"] = .string(expiresAt) }
        return json(200, body)
    }

    public static func approved(token: String, widgetToken: String?) -> Answer {
        var body: [String: JSONValue] = ["status": .string("approved"), "token": .string(token)]
        if let widgetToken { body["widgetToken"] = .string(widgetToken) }
        return json(200, body)
    }

    public static let denied = json(200, ["status": .string("denied")])
    /// 404: unknown, lapsed or already collected.
    public static let expired = json(404, ["status": .string("expired")])

    /// `{"error": message}` with `status`.
    public static func error(_ status: Int, _ message: String) -> Answer {
        json(status, ["error": .string(message)])
    }

    private static func json(_ status: Int, _ body: [String: JSONValue], date: String? = nil) -> Answer {
        let text = (try? JSONEncoder().encode(JSONValue.object(body))).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        var headers = ["Content-Type": "application/json"]
        if let date { headers["Date"] = date }
        return .http(status: status, body: text, headers: headers)
    }
}

/// Time for pairing tests and previews. A sleep returns at once and moves `now` forward by its length, so a poll
/// loop runs in no real time; with `holding: true` sleeps wait until the task is cancelled instead.
public final class MockPairingClock: PairingClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    private var slept: [Duration] = []
    private let holding: Bool

    /// Default start: 2027-01-15T08:00:00Z.
    public init(now: Date = Date(timeIntervalSince1970: 1_800_000_000), holding: Bool = false) {
        self.current = now
        self.holding = holding
    }

    /// Every sleep so far, oldest first.
    public var sleeps: [Duration] {
        lock.lock(); defer { lock.unlock() }
        return slept
    }

    public func now() -> Date {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    public func sleep(for duration: Duration) async throws {
        try Task.checkCancellation()
        if holding { try await Task.sleep(for: .seconds(24 * 3600)) }
        advance(by: duration)
        await Task.yield()
        try Task.checkCancellation()
    }

    private func advance(by duration: Duration) {
        lock.lock(); defer { lock.unlock() }
        slept.append(duration)
        let c = duration.components
        current = current.addingTimeInterval(Double(c.seconds) + Double(c.attoseconds) / 1e18)
    }
}
