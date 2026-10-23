import Foundation
import Testing
@testable import DroverKit

struct SummaryCacheTests {
    static func tempDir() -> URL {
        FileManager.default.temporaryDirectory.appending(path: "droverkit-cache-\(UUID().uuidString)")
    }

    @Test func roundTripAndBareJSON() throws {
        let dir = Self.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = SummaryCache(directory: dir)
        #expect(cache.fileURL.lastPathComponent == DroverIdentifiers.summaryCacheFile)
        let summary = try TestFixtures.summary()
        try cache.save(summary)
        let loaded = try #require(cache.load())
        #expect(loaded.summary == summary)

        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: cache.fileURL)) as? [String: Any]
        #expect(json?["generatedAt"] != nil)
        #expect(json?["ok"] == nil)
        #expect(json?["result"] == nil)
    }

    @Test func fetchedAtIsModificationDate() throws {
        let dir = Self.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = SummaryCache(directory: dir)
        try cache.save(try TestFixtures.summary())
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)
        try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: cache.fileURL.path)
        #expect(cache.load()?.fetchedAt == stamp)
    }

    @Test func missingOrCorruptIsNil() throws {
        let dir = Self.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = SummaryCache(directory: dir)
        #expect(cache.load() == nil)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: cache.fileURL)
        #expect(cache.load() == nil)
    }
}
