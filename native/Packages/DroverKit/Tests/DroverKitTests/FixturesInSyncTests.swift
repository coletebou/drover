import Foundation
import Testing
@testable import DroverKit

@Suite struct FixturesInSyncTests {
    /// Fixtures.all is a raw multi-line string, which drops the final newline: the file side loses exactly one trailing newline (the generator ends every file on a newline first).
    private func trimmed(_ s: String) -> String { s.hasSuffix("\n") ? String(s.dropLast()) : s }

    @Test func generatedFixturesMatchFiles() throws {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "Fixtures")
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".json") || $0.hasSuffix(".txt") }
        #expect(!names.isEmpty, "Fixtures directory not found at \(dir.path)")
        for name in names {
            let onDisk = try String(contentsOf: dir.appending(path: name), encoding: .utf8)
            let embedded = Fixtures.all[name]
            #expect(embedded == trimmed(onDisk), "\(name) is stale: run script/gen-fixtures.sh")
        }
        #expect(Set(Fixtures.all.keys) == Set(names), "fixture set differs: run script/gen-fixtures.sh")
    }
}
