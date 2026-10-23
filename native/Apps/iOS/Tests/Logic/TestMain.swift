import Foundation

/// Minimal test harness (XCTest needs Xcode's license; this runs with plain swiftc).
nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var passes = 0

func expect(_ cond: @autoclosure () -> Bool, _ msg: String, file: String = #fileID, line: Int = #line) {
    if cond() { passes += 1 } else { failures += 1; print("FAIL \(file):\(line) \(msg)") }
}

func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

/// Each test file adds its suite to `allSuites` via an extension of `Suites`.
enum Suites {}

@main
struct LogicTests {
    static func main() async {
        for (name, run) in Suites.all {
            do { try await run() } catch { failures += 1; print("FAIL \(name): threw \(error)") }
        }
        print("logic tests: \(passes) passed, \(failures) failed")
        exit(failures == 0 ? 0 : 1)
    }
}
