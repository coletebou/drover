import XCTest

final class NativeProtocolTests: XCTestCase {
    private func parse(_ message: Any?) -> Result<NativeRequest, NativeError> {
        NativeRequest.parse(message)
    }

    func testPingAndConfig() {
        XCTAssertEqual(parse(["v": 1, "type": "ping"] as [String: Any]), .success(.ping))
        XCTAssertEqual(parse(["v": 1, "type": "config"] as [String: Any]), .success(.config))
    }

    func testUnknownVersionIsAccepted() {
        XCTAssertEqual(parse(["v": 99, "type": "ping"] as [String: Any]), .success(.ping))
        XCTAssertEqual(parse(["type": "ping"] as [String: Any]), .success(.ping))
    }

    func testNotifyFull() {
        let message: [String: Any] = [
            "v": 1, "type": "notify", "id": "drover|demo-mac|demo-build", "title": "Done", "body": "Build finished",
            "sessionId": "demo-build", "host": "demo-mac", "kind": "idle",
        ]
        XCTAssertEqual(parse(message), .success(.notify(NotifyPayload(
            id: "drover|demo-mac|demo-build", title: "Done", body: "Build finished",
            sessionId: "demo-build", host: "demo-mac", kind: "idle"))))
    }

    func testNotifyOptionalsMissingOrNull() {
        let message: [String: Any] = [
            "type": "notify", "id": "n1", "title": "T", "body": "B", "kind": NSNull(),
        ]
        XCTAssertEqual(parse(message), .success(.notify(NotifyPayload(
            id: "n1", title: "T", body: "B", sessionId: nil, host: nil, kind: nil))))
    }

    func testNotifyBadInput() {
        XCTAssertEqual(parse(["type": "notify", "id": "n1", "title": "T"] as [String: Any]), .failure(.badRequest))
        XCTAssertEqual(parse(["type": "notify", "id": 5, "title": "T", "body": "B"] as [String: Any]), .failure(.badRequest))
        XCTAssertEqual(parse(["type": "notify", "id": "n", "title": "T", "body": "B", "sessionId": 7] as [String: Any]),
                       .failure(.badRequest))
    }

    func testClearNotification() {
        XCTAssertEqual(parse(["type": "clearNotification", "id": "n1"] as [String: Any]),
                       .success(.clearNotification(id: "n1")))
        XCTAssertEqual(parse(["type": "clearNotification"] as [String: Any]), .failure(.badRequest))
    }

    func testOpGetAndPost() {
        let get: [String: Any] = ["type": "op", "op": "native.summary", "method": "GET", "args": ["host": "demo-mac", "limit": 5]]
        XCTAssertEqual(parse(get), .success(.op(OpPayload(
            op: "native.summary", method: "GET", args: ["host": .string("demo-mac"), "limit": .number(5)]))))
        let post: [String: Any] = ["type": "op", "op": "sessions.message", "method": "POST", "args": ["flag": true]]
        XCTAssertEqual(parse(post), .success(.op(OpPayload(
            op: "sessions.message", method: "POST", args: ["flag": .bool(true)]))))
    }

    func testOpMissingArgsMeansEmpty() {
        XCTAssertEqual(parse(["type": "op", "op": "x", "method": "GET"] as [String: Any]),
                       .success(.op(OpPayload(op: "x", method: "GET", args: [:]))))
        XCTAssertEqual(parse(["type": "op", "op": "x", "method": "GET", "args": NSNull()] as [String: Any]),
                       .success(.op(OpPayload(op: "x", method: "GET", args: [:]))))
    }

    func testOpBadInput() {
        XCTAssertEqual(parse(["type": "op", "method": "GET"] as [String: Any]), .failure(.badRequest))
        XCTAssertEqual(parse(["type": "op", "op": "x", "method": "DELETE"] as [String: Any]), .failure(.badRequest))
        XCTAssertEqual(parse(["type": "op", "op": "x", "method": "get"] as [String: Any]), .failure(.badRequest))
        XCTAssertEqual(parse(["type": "op", "op": "x", "method": "GET", "args": [1, 2]] as [String: Any]),
                       .failure(.badRequest))
    }

    func testUnknownTypeAndMalformedShape() {
        XCTAssertEqual(parse(["type": "frobnicate"] as [String: Any]), .failure(.unknownType))
        XCTAssertEqual(parse(["type": 5] as [String: Any]), .failure(.badRequest))
        XCTAssertEqual(parse([:] as [String: Any]), .failure(.badRequest))
        XCTAssertEqual(parse(nil), .failure(.badRequest))
        XCTAssertEqual(parse("ping"), .failure(.badRequest))
        XCTAssertEqual(parse([1, 2] as [Any]), .failure(.badRequest))
    }

    func testResponseJSONObject() {
        let ok = NativeResponse.success(.object(["posted": .bool(true), "n": .number(2)])).jsonObject
        XCTAssertEqual(ok["ok"] as? Bool, true)
        let result = ok["result"] as? [String: Any]
        XCTAssertEqual(result?["posted"] as? Bool, true)
        XCTAssertEqual(result?["n"] as? Int, 2)

        let failure = NativeResponse.failure(.unknownType).jsonObject
        XCTAssertEqual(failure["ok"] as? Bool, false)
        XCTAssertEqual(failure["error"] as? String, "unknownType")
        XCTAssertNil(failure["result"])
    }

    func testResponseSerializesAsJSON() throws {
        let object = NativeResponse.success(.object(["baseURL": .null, "token": .null])).jsonObject
        XCTAssertTrue(JSONSerialization.isValidJSONObject(object))
        _ = try JSONSerialization.data(withJSONObject: object)
    }
}
