# DroverKit public API (pinned by window 00-core)

Other windows code against these names. Changing one is a CONTRACT change: do it in window 00-core only.
SwiftPM package at `Packages/DroverKit`, product `DroverKit`, Swift 6 language mode, iOS 17 / macOS 14 / watchOS 10,
no dependencies. `swift test` runs on macOS with the Command Line Tools; iOS and watchOS are typechecked with
`script/typecheck.sh`. If `swift test` here intermittently reports "plugin for module 'TestingMacros' not found",
add `-Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing`.
`swift build` is a stronger check than `typecheck.sh` (the latter skips definite-initialization diagnostics).

## Models (`Sources/DroverKit/Models`, match `Fixtures/`)
- `NativeSummary` (+ `HostCount`, `WaitingItem`, `WorkingItem`, `Totals`, `ManagerState`), `NativeNotifications`,
  `NotificationItem`, `SessionList`, `SessionInfo`, `Transcript` (+ `Turn`, `ToolUse`, `Summary`), `MessageDelivery`,
  `PaneCapture`, `PaneSendResult`, `HostEntry`, `OpEnvelope<T>`, `JSONValue`.
- `DroverTimestamp`: ISO 8601 string or epoch number (ms if > 1e11, else s); encodes ISO 8601 with fractional seconds.
- Open enums (unknown raw values decode fine): `Engine`, `AskKind`, `NotificationKind`, `NotificationCategory`, `TurnRole`.
- `DroverIdentifiers`: App Group, Keychain service/group suffix, summary cache file name, defaults key, URL scheme.

## Tokens (`Sources/DroverKit/Client`)
```swift
public enum TokenScope: String, Sendable, CaseIterable { case main, widget }   // Keychain accounts "main" / "widget"
public protocol TokenStore: Sendable {
    func token(for scope: TokenScope) async throws -> String?
    func setToken(_ token: String?, for scope: TokenScope) async throws          // nil deletes
}
public actor InMemoryTokenStore: TokenStore { public init(_ tokens: [TokenScope: String] = [:]) }
public struct KeychainTokenStore: TokenStore {
    /// accessGroup: full group incl. team prefix, e.g. "ABCDE12345.dev.drover.shared"; nil = app default group.
    public init(service: String = DroverIdentifiers.keychainService, accessGroup: String? = nil)
}
```
Keychain items: generic password, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (background refresh and widgets
can read after first unlock; never synced, never in backups that leave the device), `kSecUseDataProtectionKeychain`
on macOS. Token values never reach a log, an error message, or `description`.

## Client (`Sources/DroverKit/Client`)
```swift
public enum DroverError: Error, Sendable, Equatable, LocalizedError {
    case notConfigured              // no base URL or no token for the scope
    case unauthorized               // 401
    case forbidden(String?)         // 403 (e.g. widget token on a main-scope op)
    case server(status: Int, message: String?)   // { ok:false, error } or other non-2xx
    case decoding(String)           // body did not match the model (message names the op and the field)
    case transport(String)          // URLError etc. (localizedDescription; never the request headers)
    case cancelled
}
public struct DroverClient: Sendable {
    public let baseURL: URL
    public let scope: TokenScope
    public init(baseURL: URL, tokens: any TokenStore, scope: TokenScope = .main,
                session: URLSession = .shared, actor: String = "owner")
    /// Same daemon and store, other scope (a widget client from an app client).
    public func scoped(_ scope: TokenScope) -> DroverClient

    // generic
    public func call<T: Decodable & Sendable>(_ op: String, _ args: [String: JSONValue] = [:], as type: T.Type) async throws -> T   // POST /api/op/<op>
    public func get<T: Decodable & Sendable>(_ op: String, _ query: [String: String] = [:], as type: T.Type) async throws -> T      // GET  /api/op/<op>?k=v (read ops only)
    /// Authorized GET /api/stream request (Accept: text/event-stream, no timeout) for EventStream.
    public func streamRequest() async throws -> URLRequest

    // typed ops (host nil = the daemon's own machine; pass items' `host` through unchanged)
    public func summary() async throws -> NativeSummary                                        // native.summary (widget scope ok)
    public func notifications(since cursor: String?, limit: Int? = nil, wait: Int? = nil) async throws -> NativeNotifications  // widget scope ok
    public func hosts() async throws -> [HostEntry]                                            // host.list
    public func sessions(host: String? = nil) async throws -> SessionList                      // sessions.list {includeRecent:false}
    public func transcript(id: String, host: String? = nil, since: Int? = nil, limit: Int? = nil) async throws -> Transcript
    public func lastReply(id: String, host: String? = nil) async throws -> JSONValue           // sessions.lastReply
    public func sendMessage(id: String, text: String, host: String? = nil) async throws -> MessageDelivery   // sessions.message, actor = client actor
    public func capture(target: String, host: String? = nil, lines: Int? = nil) async throws -> PaneCapture
    public func sendToPane(target: String, text: String, host: String? = nil, enter: Bool = true, force: Bool = false) async throws -> PaneSendResult
    public func sendKeys(target: String, keys: [String], host: String? = nil) async throws -> PaneSendResult
    public func answer(target: String, key: String, expect: String? = nil, host: String? = nil) async throws -> PaneSendResult  // tmux.answer
    public func fleetSummary() async throws -> JSONValue                                       // fleet.summary (unmodelled)
}
```
Request rules: `Authorization: Bearer <token>` header only (never `?token=`), `Content-Type: application/json`,
`Accept: application/json`, 30 s timeout for ops (`wait` adds its seconds), body = JSON args. A 2xx body with
`ok:false` is `DroverError.server(status:200, message:error)`. 401 -> `.unauthorized`, 403 -> `.forbidden(error)`.

## Live updates (`Sources/DroverKit/Stream`)
```swift
public struct ServerEvent: Sendable, Equatable {
    public enum Kind: String, Sendable { case hello, mutation, notify, alerts, snapshot, fleet, probe, settings, turn, headless, codex, unknown }
    public let name: String          // raw event name ("message" when the server sent none)
    public let data: String          // joined data lines
    public let id: String?
    public var kind: Kind
    public func decode<T: Decodable>(_ type: T.Type) throws -> T
}
public struct SSEParser: Sendable {                 // pure; tested with Fixtures/events.sse.txt
    public init()
    public mutating func feed(line: String) -> ServerEvent?   // one line without its newline; returns on blank line
    public var retry: Duration?                                // last "retry:" field
}
public struct Backoff: Sendable, Equatable {
    public var initial: Duration; public var maximum: Duration; public var multiplier: Double; public var jitter: Double
    public static let standard: Backoff                        // 1 s, x2, max 60 s, 20 % jitter
    public func delay(attempt: Int) -> Duration                // attempt 0 = first retry
}
public enum StreamUpdate: Sendable, Equatable {
    case connecting, open, waiting(retryIn: Duration), stopped(DroverError)
    case event(ServerEvent)
}
public struct EventStream: Sendable {
    public typealias Connect = @Sendable (URLRequest) async throws -> (status: Int, lines: AsyncThrowingStream<String, any Error>)
    public init(request: @escaping @Sendable () async throws -> URLRequest, backoff: Backoff = .standard, connect: Connect? = nil)  // nil = URLSession bytes
    public init(client: DroverClient, backoff: Backoff = .standard)
    /// init(client:) streams through the client's URLSession (so MockServer clients get Fixtures/events.sse.txt).
    /// Connects on first iteration, reconnects with backoff forever, resets backoff after a good connection,
    /// ends with .stopped(.unauthorized) on 401/403 (no point retrying), ends when the consumer cancels.
    public func updates() -> AsyncStream<StreamUpdate>
}
```
Note: `URLSession.AsyncBytes.lines` drops empty lines, which are the SSE event separator. The default connector
splits the byte stream on `\n` itself (stripping a trailing `\r`) and yields empty lines too.

## Stores (`Sources/DroverKit/Store`)
```swift
public struct SummaryCache: Sendable {
    public init(directory: URL)                              // file = directory/DroverIdentifiers.summaryCacheFile
    public init?(appGroup: String = DroverIdentifiers.appGroup)  // nil when the container is unavailable (unsigned builds)
    public let fileURL: URL
    public func load() -> (summary: NativeSummary, fetchedAt: Date)?   // fetchedAt = file modification date
    public func save(_ summary: NativeSummary) throws                  // bare result JSON, atomic write
}
@MainActor @Observable public final class SummaryStore {
    public private(set) var summary: NativeSummary?
    public private(set) var fetchedAt: Date?
    public private(set) var lastError: DroverError?
    public private(set) var isRefreshing: Bool
    public init(fetch: @escaping @Sendable () async throws -> NativeSummary, cache: SummaryCache? = nil,
                onSave: (@MainActor @Sendable () -> Void)? = nil)  // onSave: e.g. WidgetCenter reload (apps only)
    public convenience init(client: DroverClient, cache: SummaryCache? = nil, onSave: (@MainActor @Sendable () -> Void)? = nil)
    public func refresh() async                                  // keeps the old summary on error
    public func startPolling(every interval: Duration)           // idempotent; refresh now, then every interval
    public func stopPolling()
    public func follow(_ stream: EventStream)                    // refresh (debounced 2 s) on mutation/notify/alerts/fleet
    public func stopFollowing()
}
public actor NotificationFeed {
    public init(fetch: @escaping @Sendable (_ since: String?) async throws -> NativeNotifications,
                defaults: UserDefaults? = UserDefaults(suiteName: DroverIdentifiers.appGroup),
                cursorKey: String = "drover.notifications.cursor")
    public init(client: DroverClient, wait: Int? = nil, defaults: UserDefaults? = ..., cursorKey: String = ...)
    /// New items since the stored cursor; stores the new cursor. First call ever: returns [] and stores the cursor
    /// (no flood of old alerts on install).
    public func poll() async throws -> [NotificationItem]
    public func reset()
}
```

## Pairing (`Sources/DroverKit/Pairing`)
A client with no token asks the daemon to pair, shows a 6-digit code, and receives both tokens once someone approves
that code on the Mac (`drover pair approve <code>` or Approve in the browser UI). Daemon contract: `web/README.md`
"Pairing devices". Neither request carries an Authorization header; the request id stays in memory, never printed.
```swift
public struct PairingClient: Sendable {
    public init(baseURL: URL, transport: any PairingTransport = URLSessionPairingTransport(),
                clock: any PairingClock = SystemPairingClock())
    /// requesting, waiting(code, expiresAt), then one of approved/denied/expired/failed. Cancel the consumer to stop.
    public func states(client: String, device: String) -> AsyncStream<PairingState>
    public func request(client: String, device: String) async throws -> PairingTicket   // POST /api/pair/request
    public func status(of ticket: PairingTicket) async throws -> PairingStatus            // GET /api/pair/status?requestId=
    public static func label(_ raw: String) -> String       // whitespace collapsed, <= 64 UTF-16 units
    public static func isLoopback(_ url: URL) -> Bool        // 127/8, ::1, localhost: apps pair on their own only here
}
public enum PairingState { case idle, requesting, waiting(code:expiresAt:), approved(PairingTokens), denied, expired, failed(String) }
public struct PairingTokens { public let main: String; public let widget: String? }   // description and mirror redacted
@MainActor @Observable public final class PairingController {   // what the apps drive
    public private(set) var phase: PairingPhase   // idle, requesting, waiting(code:expiresAt:), paired, denied, expired, failed
    public private(set) var serverURL: URL?
    public init(makeClient: @escaping @Sendable (URL) -> PairingClient = { PairingClient(baseURL: $0) })
    public func start(baseURL: URL, client: String, device: String, onApproved: @escaping @MainActor (PairingTokens) throws -> Void)
    public func cancel(); public func reset()
}
public enum PairingCode { ... }   // formatted("123456") == "123 456", approveCommand, instructions (Markdown), spoken
```
Polls every `pollMs` (clamped to 0.25...10 s) and keeps polling through network blips and 5xx until the deadline: the
request's `expiresAt` (at most 15 min), measured against the daemon's `Date` header so a device whose clock is off
still waits the full lifetime. A `pending` reply can bring the deadline closer (a new `waiting` follows) but never
later, so no daemon can keep a client polling; the last poll lands on the deadline, then `expired`. After a cancel, a
reply already on its way is dropped (`PairingController.cancel()` also ignores late states), so a connection the user
saves by hand is never overwritten. 401/404 on request mean a daemon without pairing (`.unsupported`), 429 too many
pending. Portable: no Apple-only API, tested on Linux CI. Test suites must not be named `*ClientTests` or `*GlueTests`:
CI's `swift test --skip ClientTests --skip GlueTests` matches substrings. The pairing suites carry a one-minute time
limit, so a poll-loop regression fails instead of hanging CI.

## Mocks (`Sources/DroverKit/Mock`)
```swift
public enum Fixtures { public static let all: [String: String] }   // file name -> JSON text, generated by script/gen-fixtures.sh
public final class MockURLProtocol: URLProtocol { ... }           // serves /api/op/<op> from Fixtures (or overrides)
public enum MockServer {
    public static let baseURL: URL                                 // http://drover.mock
    public static func session(overrides: [String: String] = [:]) -> URLSession   // op -> raw JSON body
    public static func client(scope: TokenScope = .main) -> DroverClient              // token "mock-token"
    public static var summary: NativeSummary { get }               // decoded Fixtures/native-summary.json, for SwiftUI previews
    public static var notifications: NativeNotifications { get }
    public static var sessions: SessionList { get }
    public static var transcript: Transcript { get }
}
public final class MockPairingTransport: PairingTransport {     // scripted daemon answers (last repeats), records requests
    public init(_ answers: [Answer])   // .http(status:body:headers:), .unreachable, .hang, .late(answer, after:) (survives a cancel)
    public var requests: [URLRequest] { get }
    // canned answers: created(code:expiresAt:pollMs:requestId:date:), pending(expiresAt:), approved(token:widgetToken:),
    // denied, expired (404), error(status, message)
}
public final class MockPairingClock: PairingClock {             // sleeps return at once and advance now; holding: wait for cancel
    public init(now: Date = 2027-01-15T08:00:00Z, holding: Bool = false); public var sleeps: [Duration] { get }
}
```
