import Foundation

/// Minimal test runner (no XCTest available without the Xcode license). Register suites in main.swift.
@MainActor
enum T {
    static var failures = 0
    static var passes = 0
    static var current = ""

    static func suite(_ name: String, _ body: () async throws -> Void) async {
        current = name
        do { try await body() } catch { fail("threw \(error)") }
    }

    static func check(_ cond: @autoclosure () -> Bool, _ msg: @autoclosure () -> String = "", file: StaticString = #fileID, line: UInt = #line) {
        if cond() { passes += 1 } else { fail("\(msg()) (\(file):\(line))") }
    }

    static func eq<V: Equatable>(_ a: V, _ b: V, _ msg: String = "", file: StaticString = #fileID, line: UInt = #line) {
        if a == b { passes += 1 } else { fail("\(msg) expected \(b), got \(a) (\(file):\(line))") }
    }

    static func fail(_ msg: String) {
        failures += 1
        FileHandle.standardError.write(Data("FAIL [\(current)] \(msg)\n".utf8))
    }

    static func json(_ s: String) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))
    }
}
