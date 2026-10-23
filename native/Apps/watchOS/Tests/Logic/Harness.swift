import Foundation

struct TestCase: Sendable {
    let name: String
    let body: @MainActor @Sendable () async throws -> Void
    init(_ name: String, _ body: @escaping @MainActor @Sendable () async throws -> Void) {
        self.name = name
        self.body = body
    }
}

struct TestFailure: Error, CustomStringConvertible {
    let description: String
}

func expect(_ cond: @autoclosure () throws -> Bool, _ msg: @autoclosure () -> String = "expectation failed",
            file: StaticString = #fileID, line: UInt = #line) throws {
    if try !cond() { throw TestFailure(description: "\(file):\(line): \(msg())") }
}

func expectEqual<T: Equatable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T,
                               _ msg: String = "", file: StaticString = #fileID, line: UInt = #line) throws {
    let x = try a(), y = try b()
    if x != y { throw TestFailure(description: "\(file):\(line): expected \(y), got \(x) \(msg)") }
}

@MainActor func expectThrows<E: Error & Equatable>(_ expected: E, file: StaticString = #fileID, line: UInt = #line,
                                        _ body: () async throws -> Void) async throws {
    do {
        try await body()
    } catch let e as E {
        if e != expected { throw TestFailure(description: "\(file):\(line): threw \(e), expected \(expected)") }
        return
    } catch {
        throw TestFailure(description: "\(file):\(line): threw \(error), expected \(expected)")
    }
    throw TestFailure(description: "\(file):\(line): did not throw, expected \(expected)")
}

func expect<E: Error & Equatable>(throws expected: E, file: StaticString = #fileID, line: UInt = #line,
                                  _ body: () throws -> Void) throws {
    do { try body() } catch let e as E {
        if e != expected { throw TestFailure(description: "\(file):\(line): threw \(e), expected \(expected)") }
        return
    } catch { throw TestFailure(description: "\(file):\(line): threw \(error), expected \(expected)") }
    throw TestFailure(description: "\(file):\(line): did not throw, expected \(expected)")
}

/// Loads a JSON fixture from Apps/watchOS/Tests/Fixtures.
func fixture(_ name: String) throws -> Data {
    let dir = ProcessInfo.processInfo.environment["DROVER_FIXTURES"] ?? "Fixtures"
    return try Data(contentsOf: URL(fileURLWithPath: dir).appending(path: name))
}

/// Fresh, isolated UserDefaults for one test.
func scratchDefaults() -> UserDefaults {
    let name = "drover.watch.tests.\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
}

func scratchFile(_ name: String = "summary.json") -> URL {
    FileManager.default.temporaryDirectory.appending(path: "drover-watch-tests-\(UUID().uuidString)").appending(path: name)
}

// MARK: HTTP stub

/// URLProtocol stub: records requests, answers with a canned response per op name.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Recorded: Sendable { let url: URL; let method: String; let headers: [String: String]; let body: Data }
    nonisolated(unsafe) static var responses: [String: (Int, Data)] = [:]
    nonisolated(unsafe) static var recorded: [Recorded] = []
    nonisolated(unsafe) static var failWith: URLError?
    /// Runs while the request is "in flight" (before the response is delivered).
    nonisolated(unsafe) static var onRequest: (() -> Void)?

    static func reset() { responses = [:]; recorded = []; failWith = nil; onRequest = nil }

    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: c)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let s = request.httpBodyStream {
            s.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            s.close()
        }
        let url = request.url!
        Self.recorded.append(Recorded(url: url, method: request.httpMethod ?? "GET",
                                      headers: request.allHTTPHeaderFields ?? [:], body: body))
        Self.onRequest?()
        if let e = Self.failWith { client?.urlProtocol(self, didFailWithError: e); return }
        let op = url.lastPathComponent
        let (status, data) = Self.responses[op] ?? (404, Data(#"{"ok":false,"error":"unknown op"}"#.utf8))
        let resp = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

func envelope(_ resultJSON: String) -> Data { Data(#"{"ok":true,"result":\#(resultJSON),"ms":3}"#.utf8) }
