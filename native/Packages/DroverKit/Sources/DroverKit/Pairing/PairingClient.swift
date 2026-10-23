import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The HTTP exchange `PairingClient` needs. `URLSessionPairingTransport` is the real one; `MockPairingTransport`
/// scripts it for tests and previews.
public protocol PairingTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// URLSession with no cache and no cookies: pairing answers carry tokens and must never be stored.
public struct URLSessionPairingTransport: PairingTransport {
    private let session: URLSession

    public init(session: URLSession = URLSessionPairingTransport.ephemeral) {
        self.session = session
    }

    public static let ephemeral: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }()

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw PairingError.transport("Not an HTTP response.") }
        return (data, http)
    }
}

/// Wall-clock time (a code's expiry is a wall-clock time) and sleeping, for the poll loop. Tests use
/// `MockPairingClock`.
public protocol PairingClock: Sendable {
    func now() -> Date
    /// Throws when the task is cancelled.
    func sleep(for duration: Duration) async throws
}

public struct SystemPairingClock: PairingClock {
    public init() {}
    public func now() -> Date { Date() }
    public func sleep(for duration: Duration) async throws { try await Task.sleep(for: duration) }
}

/// Pairs an app with a Drover daemon so nobody has to paste a token: ask for a code (`POST /api/pair/request`),
/// show it, ask for the outcome every `pollMs` (`GET /api/pair/status`) until someone approves or denies it on the
/// Mac or it lapses, then hand over both tokens. Neither request carries an Authorization header. The request id
/// is the client's secret: it stays in memory and never reaches a log or an error message.
public struct PairingClient: Sendable {
    public let baseURL: URL
    private let transport: any PairingTransport
    private let clock: any PairingClock

    /// The daemon's code lifetime, assumed when an answer carries no usable expiry.
    static let defaultLifetime: TimeInterval = 120
    /// The longest wait this client accepts, whatever an answer says.
    static let maximumLifetime: TimeInterval = 15 * 60
    static let timeout: TimeInterval = 15
    /// Longest `client` and `device` the daemon accepts (it counts JavaScript string length: UTF-16 units).
    public static let labelLimit = 64

    public init(baseURL: URL, transport: any PairingTransport = URLSessionPairingTransport(),
                clock: any PairingClock = SystemPairingClock()) {
        self.baseURL = baseURL
        self.transport = transport
        self.clock = clock
    }

    // MARK: flow

    /// The whole flow: `requesting`, `waiting(code, expiresAt)`, then exactly one of `approved`, `denied`,
    /// `expired` or `failed`, and the stream ends. Cancelling the consuming task (or dropping the stream) stops it:
    /// no further request is sent, a reply already on its way is dropped, and no final state follows. Transient poll
    /// failures are retried until the code lapses. The deadline is the request's `expiresAt`: a `pending` reply can
    /// bring it closer (a new `waiting` says so) but never later, so a daemon cannot keep a client polling. The last
    /// poll lands at the deadline, so an approval just before it still arrives, and expiry follows that poll.
    public func states(client: String, device: String) -> AsyncStream<PairingState> {
        let (stream, continuation) = AsyncStream<PairingState>.makeStream()
        let task = Task {
            await run(client: client, device: device) { continuation.yield($0) }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    func run(client: String, device: String, emit: (PairingState) -> Void) async {
        emit(.requesting)
        let ticket: PairingTicket
        do {
            ticket = try await request(client: client, device: device)
        } catch {
            if let final = Self.finalState(error) { emit(final) }
            return
        }
        if Task.isCancelled { return }
        emit(.waiting(code: ticket.code, expiresAt: ticket.expiresAt))
        var deadline = ticket.expiresAt
        while true {
            // Never past the deadline: the last poll lands on it.
            let wait = min(ticket.pollInterval, Self.duration(deadline.timeIntervalSince(clock.now())))
            do { try await clock.sleep(for: wait) } catch { return }
            if Task.isCancelled { return }
            let answer: PairingStatus
            do {
                answer = try await status(of: ticket)
            } catch let e as PairingError where e.isTransient {
                // Wi-Fi, the tailnet or a daemon restart: the code stays valid until the deadline, so keep asking.
                if Task.isCancelled { return }
                if clock.now() >= deadline { emit(.expired); return }
                continue
            } catch {
                if let final = Self.finalState(error) { emit(final) }
                return
            }
            // A reply that arrives after a cancel is dropped: the caller may already have configured something else.
            if Task.isCancelled { return }
            switch answer {
            case .approved(let tokens): emit(.approved(tokens)); return
            case .denied: emit(.denied); return
            case .expired: emit(.expired); return
            case .pending(let expiresAt):
                if let expiresAt, expiresAt < deadline {
                    deadline = expiresAt
                    emit(.waiting(code: ticket.code, expiresAt: deadline))
                }
            }
            if clock.now() >= deadline { emit(.expired); return }
        }
    }

    /// Seconds as a Duration, never negative.
    static func duration(_ seconds: TimeInterval) -> Duration {
        .milliseconds(Int((max(0, seconds) * 1000).rounded(.up)))
    }

    /// nil when the error means the caller cancelled.
    static func finalState(_ error: any Error) -> PairingState? {
        if error is CancellationError { return nil }
        if let e = error as? PairingError {
            return e == .cancelled ? nil : .failed(e.errorDescription ?? "Pairing failed.")
        }
        return .failed(PairingError.transport(error.localizedDescription).errorDescription ?? "Pairing failed.")
    }

    // MARK: endpoints

    /// `POST /api/pair/request` with `{"client", "device"}` (each cleaned up by `label`), no Authorization header.
    public func request(client: String, device: String) async throws -> PairingTicket {
        var request = URLRequest(url: try endpoint("api/pair/request"))
        request.httpMethod = "POST"
        request.timeoutInterval = Self.timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try? JSONEncoder().encode(RequestBody(client: Self.label(client), device: Self.label(device)))
        let (data, response) = try await send(request, hiding: nil)
        let status = response.statusCode
        switch status {
        case 200..<300: break
        case 401, 404: throw PairingError.unsupported
        case 429: throw PairingError.tooManyRequests
        case 400..<500: throw PairingError.refused(status: status, message: Self.errorMessage(data))
        default: throw PairingError.server(status: status, message: Self.errorMessage(data))
        }
        guard let answer = try? JSONDecoder().decode(RequestAnswer.self, from: data) else {
            throw PairingError.badResponse("not a pairing request answer")
        }
        guard let id = answer.requestId, Self.isRequestId(id) else { throw PairingError.badResponse("requestId") }
        guard let code = answer.code, Self.isCode(code) else { throw PairingError.badResponse("code") }
        let now = clock.now()
        let expiresAt = Self.localExpiry(answer.expiresAt, response: response, now: now)
            ?? now.addingTimeInterval(Self.defaultLifetime)
        return PairingTicket(requestId: id, code: code, expiresAt: expiresAt, pollInterval: Self.pollInterval(answer.pollMs))
    }

    /// `GET /api/pair/status?requestId=<id>`, no Authorization header. 404 means expired (unknown, lapsed or
    /// already collected); 408, 429 and 5xx throw a transient `.server`.
    public func status(of ticket: PairingTicket) async throws -> PairingStatus {
        var comps = URLComponents(url: try endpoint("api/pair/status"), resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "requestId", value: ticket.requestId)]
        guard let url = comps?.url else { throw PairingError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = Self.timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await send(request, hiding: ticket.requestId)
        let status = response.statusCode
        let answer = try? JSONDecoder().decode(StatusAnswer.self, from: data)
        if status == 404 || answer?.status == "expired" { return .expired }
        switch status {
        case 200..<300: break
        case 408, 429, 500...: throw PairingError.server(status: status, message: Self.errorMessage(data, hiding: ticket.requestId))
        default: throw PairingError.refused(status: status, message: Self.errorMessage(data, hiding: ticket.requestId))
        }
        guard let answer else { throw PairingError.badResponse("not a pairing status answer") }
        switch answer.status {
        case "approved":
            guard let main = Self.nonEmpty(answer.token) else { throw PairingError.badResponse("approved without a token") }
            return .approved(PairingTokens(main: main, widget: Self.nonEmpty(answer.widgetToken)))
        case "denied":
            return .denied
        default:
            // "pending", or a state this client does not know yet: keep asking until the code lapses.
            return .pending(expiresAt: Self.localExpiry(answer.expiresAt, response: response, now: clock.now()))
        }
    }

    // MARK: helpers

    /// Only http and https, and only scheme, host, port and path of the base: a query or credentials in the
    /// configured address never ride along on these unauthenticated requests.
    private func endpoint(_ path: String) throws -> URL {
        guard let scheme = baseURL.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = baseURL.host, !host.isEmpty,
              var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { throw PairingError.invalidURL }
        comps.user = nil
        comps.password = nil
        comps.query = nil
        comps.fragment = nil
        guard let base = comps.url else { throw PairingError.invalidURL }
        return base.appending(path: path)
    }

    private func send(_ request: URLRequest, hiding secret: String?) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await transport.send(request)
        } catch let e as PairingError {
            throw e
        } catch is CancellationError {
            throw PairingError.cancelled
        } catch let e as URLError where e.code == .cancelled {
            throw PairingError.cancelled
        } catch {
            if Task.isCancelled { throw PairingError.cancelled }
            throw PairingError.transport(Self.scrub(error.localizedDescription, hiding: secret))
        }
    }

    /// `client` and `device` the way the daemon keeps them: control characters and runs of whitespace become one
    /// space, at most `labelLimit` UTF-16 units, never half a character.
    public static func label(_ raw: String) -> String {
        let words = raw.split { ch in
            ch.isWhitespace || ch.unicodeScalars.contains { $0.properties.generalCategory == .control }
        }
        var out = ""
        var units = 0
        for ch in words.joined(separator: " ") {
            units += ch.utf16.count
            if units > labelLimit { break }
            out.append(ch)
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    /// The daemon on this machine: 127.0.0.0/8, ::1 or localhost. Apps pair on their own only with these.
    public static func isLoopback(_ url: URL) -> Bool {
        guard var host = url.host?.lowercased() else { return false }
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host == "localhost" || host == "localhost." || host == "::1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        return octets.count == 4 && octets.allSatisfy { UInt8($0) != nil } && octets[0] == "127"
    }

    /// The daemon's `pollMs`, 1.5 s when missing, kept within 0.25 to 10 s.
    static func pollInterval(_ ms: Double?) -> Duration {
        guard let ms, ms.isFinite else { return .milliseconds(1500) }
        return .milliseconds(Int(min(10_000, max(250, ms.rounded()))))
    }

    /// The daemon's expiry on this device's clock: measured against the daemon's own `Date` header when it sent
    /// one, so a phone whose clock is off still waits the code's whole lifetime. nil when `iso` is not a date.
    static func localExpiry(_ iso: String?, response: HTTPURLResponse, now: Date) -> Date? {
        guard let iso, let expires = DroverTimestamp(iso: iso)?.date else { return nil }
        var remaining = expires.timeIntervalSince(now)
        if let header = response.value(forHTTPHeaderField: "Date"), let serverNow = httpDate(header) {
            remaining = expires.timeIntervalSince(serverNow)
        }
        return now.addingTimeInterval(min(max(remaining, 0), maximumLifetime))
    }

    /// IMF-fixdate, the `Date` header format: "Fri, 15 Jan 2027 08:00:00 GMT".
    static func httpDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return f.date(from: s.trimmingCharacters(in: .whitespaces))
    }

    /// The daemon sends 32 lowercase hex digits; accept any short id that is safe in a query.
    static func isRequestId(_ s: String) -> Bool {
        (1...128).contains(s.utf8.count) && s.utf8.allSatisfy { b in
            (0x30...0x39).contains(b) || (0x41...0x5A).contains(b) || (0x61...0x7A).contains(b) || b == 0x2D || b == 0x5F
        }
    }

    /// The daemon sends 6 digits.
    static func isCode(_ s: String) -> Bool {
        (4...12).contains(s.utf8.count) && s.utf8.allSatisfy { (0x30...0x39).contains($0) }
    }

    private static func nonEmpty(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    /// The `error` of an error answer: one line, at most 200 characters, never the request id.
    static func errorMessage(_ data: Data, hiding secret: String? = nil) -> String? {
        guard let raw = (try? JSONDecoder().decode(ErrorAnswer.self, from: data))?.error else { return nil }
        let line = scrub(raw.split(whereSeparator: \.isWhitespace).joined(separator: " "), hiding: secret)
        guard !line.isEmpty else { return nil }
        return line.count > 200 ? String(line.prefix(200)) + "..." : line
    }

    private static func scrub(_ s: String, hiding secret: String?) -> String {
        guard let secret, !secret.isEmpty else { return s }
        return s.replacingOccurrences(of: secret, with: "<request id>")
    }

    // MARK: wire shapes (lenient: a field of the wrong type reads as missing)

    private struct RequestBody: Encodable {
        let client: String
        let device: String
    }

    private enum Keys: String, CodingKey { case requestId, code, expiresAt, pollMs, status, token, widgetToken, error }

    private struct RequestAnswer: Decodable {
        var requestId: String?, code: String?, expiresAt: String?, pollMs: Double?
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            requestId = try? c.decode(String.self, forKey: .requestId)
            code = try? c.decode(String.self, forKey: .code)
            expiresAt = try? c.decode(String.self, forKey: .expiresAt)
            pollMs = try? c.decode(Double.self, forKey: .pollMs)
        }
    }

    private struct StatusAnswer: Decodable {
        var status: String?, expiresAt: String?, token: String?, widgetToken: String?
        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            status = try? c.decode(String.self, forKey: .status)
            expiresAt = try? c.decode(String.self, forKey: .expiresAt)
            token = try? c.decode(String.self, forKey: .token)
            widgetToken = try? c.decode(String.self, forKey: .widgetToken)
        }
    }

    private struct ErrorAnswer: Decodable {
        var error: String?
        init(from decoder: any Decoder) throws {
            error = try? decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .error)
        }
    }
}
