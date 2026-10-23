import XCTest

final class OpRequestBuilderTests: XCTestCase {
    private let base = URL(string: "http://127.0.0.1:7337")!
    private let token = "test-token-123"

    func testGetEncodesArgsAsQuery() throws {
        let request = try OpRequestBuilder.make(
            base: base, token: token, op: "native.summary", method: "GET",
            args: ["host": .string("demo-mac"), "limit": .number(5), "all": .bool(true), "q": .string("a b&c")])
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString,
                       "http://127.0.0.1:7337/api/op/native.summary?all=true&host=demo-mac&limit=5&q=a%20b%26c")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token-123")
        XCTAssertNil(request.httpBody)
    }

    func testGetWithoutArgsHasNoQuery() throws {
        let request = try OpRequestBuilder.make(base: base, token: token, op: "ping", method: "GET", args: [:])
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7337/api/op/ping")
    }

    func testGetNonStringValuesAreJSONText() throws {
        let request = try OpRequestBuilder.make(
            base: base, token: token, op: "x", method: "GET",
            args: ["o": .object(["a": .number(1)]), "n": .null])
        let query = request.url?.query
        XCTAssertEqual(query, "n=null&o=%7B%22a%22%3A1%7D")
    }

    func testPostSendsJSONBody() throws {
        let request = try OpRequestBuilder.make(
            base: base, token: token, op: "sessions.message", method: "POST",
            args: ["id": .string("demo-build"), "text": .string("hello"), "actor": .string("safari")])
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:7337/api/op/sessions.message")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token-123")
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertEqual(String(data: body, encoding: .utf8), #"{"actor":"safari","id":"demo-build","text":"hello"}"#)
    }

    func testBaseWithTrailingSlashAndPath() throws {
        let request = try OpRequestBuilder.make(
            base: URL(string: "https://example.test/drover/")!, token: token, op: "ping", method: "GET", args: [:])
        XCTAssertEqual(request.url?.absoluteString, "https://example.test/drover/api/op/ping")
    }

    func testOpNameValidation() {
        for good in ["a", "native.summary", "sessions.message", "A1_b-c.d", String(repeating: "a", count: 64)] {
            XCTAssertTrue(OpRequestBuilder.isValidOp(good), good)
        }
        for bad in ["", "1abc", ".abc", "-abc", "a/b", "a b", "a?b", "a..%2f", "../x", "é", "a\n", String(repeating: "a", count: 65)] {
            XCTAssertFalse(OpRequestBuilder.isValidOp(bad), bad)
            XCTAssertThrowsError(try OpRequestBuilder.make(base: base, token: token, op: bad, method: "GET", args: [:])) {
                XCTAssertEqual($0 as? NativeError, .badRequest)
            }
        }
    }

    func testBadMethodAndTokenRejected() {
        XCTAssertThrowsError(try OpRequestBuilder.make(base: base, token: token, op: "x", method: "PUT", args: [:])) {
            XCTAssertEqual($0 as? NativeError, .badRequest)
        }
        XCTAssertThrowsError(try OpRequestBuilder.make(base: base, token: "", op: "x", method: "GET", args: [:]))
        XCTAssertThrowsError(try OpRequestBuilder.make(base: base, token: "a\nb", op: "x", method: "GET", args: [:]))
    }
}
