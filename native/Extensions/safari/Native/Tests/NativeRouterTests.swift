import XCTest

private struct FakeCredentials: CredentialReading {
    var base: URL?
    var secret: String?
    func baseURL() -> URL? { base }
    func token() -> String? { secret }
}

private final class FakeNotifier: NotificationPosting, @unchecked Sendable {
    private let lock = NSLock()
    private var _posted: [NotifyPayload] = []
    private var _cleared: [String] = []
    var failure: NativeError?

    var posted: [NotifyPayload] { lock.withLock { _posted } }
    var cleared: [String] { lock.withLock { _cleared } }

    func post(_ p: NotifyPayload) async throws(NativeError) {
        if let failure { throw failure }
        lock.withLock { _posted.append(p) }
    }

    func clear(id: String) async {
        lock.withLock { _cleared.append(id) }
    }
}

private final class FakeHTTP: HTTPPerforming, @unchecked Sendable {
    private let lock = NSLock()
    private var _requests: [URLRequest] = []
    var status = 200
    var data = Data(#"{"ok":true}"#.utf8)
    var error: Error?

    var requests: [URLRequest] { lock.withLock { _requests } }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { _requests.append(request) }
        if let error { throw error }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (data, response)
    }
}

final class NativeRouterTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:7337")!
    private let token = "test-token-123"

    private func makeRouter(
        base: URL? = URL(string: "http://127.0.0.1:7337"), token: String? = "test-token-123",
        notifier: FakeNotifier = FakeNotifier(), http: FakeHTTP = FakeHTTP()
    ) -> NativeRouter {
        NativeRouter(credentials: FakeCredentials(base: base, secret: token), notifier: notifier, http: http,
                     platform: "macOS", version: "1.2.3")
    }

    private func object(_ response: NativeResponse) -> [String: Any] { response.jsonObject }

    func testPing() async {
        let r = object(await makeRouter().handle(["v": 1, "type": "ping"] as [String: Any]))
        XCTAssertEqual(r["ok"] as? Bool, true)
        let result = r["result"] as? [String: Any]
        XCTAssertEqual(result?["protocol"] as? Int, 1)
        XCTAssertEqual(result?["platform"] as? String, "macOS")
        XCTAssertEqual(result?["version"] as? String, "1.2.3")
    }

    func testConfigConfiguredStripsTrailingSlash() async {
        let router = makeRouter(base: URL(string: "http://127.0.0.1:7337/"))
        let r = object(await router.handle(["type": "config"] as [String: Any]))
        let result = r["result"] as? [String: Any]
        XCTAssertEqual(result?["baseURL"] as? String, "http://127.0.0.1:7337")
        XCTAssertEqual(result?["token"] as? String, "test-token-123")
    }

    func testConfigMissingGivesNulls() async {
        let r = object(await makeRouter(base: nil, token: nil).handle(["type": "config"] as [String: Any]))
        XCTAssertEqual(r["ok"] as? Bool, true)
        let result = r["result"] as? [String: Any]
        XCTAssertTrue(result?["baseURL"] is NSNull)
        XCTAssertTrue(result?["token"] is NSNull)
    }

    func testOpSuccessGet() async {
        let http = FakeHTTP()
        http.status = 201
        http.data = Data(#"{"result":{"n":1}}"#.utf8)
        let message: [String: Any] = ["type": "op", "op": "native.summary", "method": "GET", "args": ["host": "demo-mac"]]
        let r = object(await makeRouter(http: http).handle(message))
        XCTAssertEqual(r["ok"] as? Bool, true)
        let result = r["result"] as? [String: Any]
        XCTAssertEqual(result?["status"] as? Int, 201)
        XCTAssertEqual(result?["body"] as? String, #"{"result":{"n":1}}"#)
        XCTAssertEqual(http.requests.count, 1)
        XCTAssertEqual(http.requests.first?.url?.absoluteString, "http://127.0.0.1:7337/api/op/native.summary?host=demo-mac")
        XCTAssertEqual(http.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer test-token-123")
    }

    func testOpPassesThroughNon2xxStatus() async {
        let http = FakeHTTP()
        http.status = 401
        let message: [String: Any] = ["type": "op", "op": "x", "method": "POST", "args": [:] as [String: Any]]
        let result = object(await makeRouter(http: http).handle(message))["result"] as? [String: Any]
        XCTAssertEqual(result?["status"] as? Int, 401)
    }

    func testOpRefusesWhenSharedServerChanged() async {
        let http = FakeHTTP()
        let stale: [String: Any] = ["type": "op", "op": "sessions.message", "method": "POST",
                                    "args": ["id": "demo-build", "text": "hi"], "origin": "http://demo-mac:8080"]
        let r = object(await makeRouter(http: http).handle(stale))
        XCTAssertEqual(r["error"] as? String, "notConfigured")
        XCTAssertEqual(http.requests.count, 0)
        var same = stale
        same["origin"] = "http://127.0.0.1:7337"
        let ok = object(await makeRouter(http: http).handle(same))
        XCTAssertEqual(ok["ok"] as? Bool, true)
        XCTAssertEqual(http.requests.count, 1)
    }

    func testOpUsesATypedTokenForThatRequestOnly() async {
        let http = FakeHTTP()
        let typed: [String: Any] = ["type": "op", "op": "fleet.summary", "method": "POST",
                                    "origin": "http://127.0.0.1:7337", "token": "typed-token-456"]
        _ = await makeRouter(http: http).handle(typed)
        var plain = typed
        plain["token"] = nil
        _ = await makeRouter(http: http).handle(plain)
        XCTAssertEqual(http.requests.map { $0.value(forHTTPHeaderField: "Authorization") },
                       ["Bearer typed-token-456", "Bearer test-token-123"])
        var empty = typed
        empty["token"] = ""
        let r = object(await makeRouter(http: http).handle(empty))
        XCTAssertEqual(r["error"] as? String, "badRequest")
    }

    func testOriginMatchesJavaScriptURLOrigin() {
        XCTAssertEqual(NativeRouter.origin(of: URL(string: "http://127.0.0.1:7337/x/")!), "http://127.0.0.1:7337")
        XCTAssertEqual(NativeRouter.origin(of: URL(string: "HTTPS://Demo-Mac.example.ts.net:443")!), "https://demo-mac.example.ts.net")
        XCTAssertEqual(NativeRouter.origin(of: URL(string: "http://demo-mac:80")!), "http://demo-mac")
        XCTAssertEqual(NativeRouter.origin(of: URL(string: "http://[::1]:7337")!), "http://[::1]:7337")
    }

    func testOpNotConfigured() async {
        let message: [String: Any] = ["type": "op", "op": "x", "method": "GET"]
        for router in [makeRouter(base: nil), makeRouter(token: nil), makeRouter(base: nil, token: nil)] {
            let r = object(await router.handle(message))
            XCTAssertEqual(r["ok"] as? Bool, false)
            XCTAssertEqual(r["error"] as? String, "notConfigured")
        }
    }

    func testOpBadOpName() async {
        let http = FakeHTTP()
        let message: [String: Any] = ["type": "op", "op": "../etc", "method": "GET"]
        let r = object(await makeRouter(http: http).handle(message))
        XCTAssertEqual(r["error"] as? String, "badRequest")
        XCTAssertTrue(http.requests.isEmpty)
    }

    func testOpNetworkError() async {
        let http = FakeHTTP()
        http.error = URLError(.notConnectedToInternet)
        let r = object(await makeRouter(http: http).handle(["type": "op", "op": "x", "method": "GET"] as [String: Any]))
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "network")
    }

    func testOpNonUTF8BodyIsNetwork() async {
        let http = FakeHTTP()
        http.data = Data([0xFF, 0xFE, 0xFD])
        let r = object(await makeRouter(http: http).handle(["type": "op", "op": "x", "method": "GET"] as [String: Any]))
        XCTAssertEqual(r["error"] as? String, "network")
    }

    func testNotifyPostsAndClears() async {
        let notifier = FakeNotifier()
        let router = makeRouter(notifier: notifier)
        let notify: [String: Any] = [
            "type": "notify", "id": "n1", "title": "Done", "body": "ok", "sessionId": "demo-build", "host": "demo-mac",
        ]
        let r = object(await router.handle(notify))
        XCTAssertEqual((r["result"] as? [String: Any])?["posted"] as? Bool, true)
        XCTAssertEqual(notifier.posted.first?.sessionId, "demo-build")
        XCTAssertEqual(notifier.posted.first?.host, "demo-mac")

        let c = object(await router.handle(["type": "clearNotification", "id": "n1"] as [String: Any]))
        XCTAssertEqual((c["result"] as? [String: Any])?["cleared"] as? Bool, true)
        XCTAssertEqual(notifier.cleared, ["n1"])
    }

    func testNotifyNotAuthorized() async {
        let notifier = FakeNotifier()
        notifier.failure = .notAuthorized
        let message: [String: Any] = ["type": "notify", "id": "n1", "title": "T", "body": "B"]
        let r = object(await makeRouter(notifier: notifier).handle(message))
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "notAuthorized")
    }

    func testUnknownTypeAndBadShape() async {
        let router = makeRouter()
        let unknown = object(await router.handle(["type": "nope"] as [String: Any]))
        let missing = object(await router.handle(nil))
        let wrongShape = object(await router.handle("ping"))
        let wrongType = object(await router.handle(["type": 3] as [String: Any]))
        XCTAssertEqual(unknown["error"] as? String, "unknownType")
        XCTAssertEqual(missing["error"] as? String, "badRequest")
        XCTAssertEqual(wrongShape["error"] as? String, "badRequest")
        XCTAssertEqual(wrongType["error"] as? String, "badRequest")
    }

    func testTokenNeverAppearsInErrors() async {
        let failingHTTP = FakeHTTP()
        failingHTTP.error = URLError(.timedOut)
        let notifier = FakeNotifier()
        notifier.failure = .notAuthorized
        let messages: [Any?] = [
            ["type": "op", "op": "x", "method": "GET"] as [String: Any],
            ["type": "op", "op": "bad op", "method": "GET"] as [String: Any],
            ["type": "notify", "id": "n", "title": "T", "body": "B"] as [String: Any],
            ["type": "nope"] as [String: Any],
            nil,
        ]
        let routers = [
            makeRouter(notifier: notifier, http: failingHTTP),
            makeRouter(base: nil, token: token),
            makeRouter(base: base, token: nil),
        ]
        for router in routers {
            for message in messages {
                let response = await router.handle(message)
                guard case .failure(let error) = response else { continue }
                let data = try? JSONSerialization.data(withJSONObject: response.jsonObject)
                let text = String(data: data ?? Data(), encoding: .utf8) ?? ""
                XCTAssertFalse(text.contains(token), "token leaked in \(error)")
                XCTAssertFalse(text.contains("127.0.0.1"), "base URL leaked in \(error)")
                XCTAssertFalse(error.rawValue.contains(token))
            }
        }
    }
}
