import Foundation
import Testing
@testable import DroverWidgetCore

@Suite struct SummaryCacheTests {
    private func tempDir() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("drover-cache-\(UUID().uuidString)")
    }

    @Test func roundTrip() throws {
        let cache = SummaryCache(directory: tempDir())
        defer { if let d = cache.directory { try? FileManager.default.removeItem(at: d) } }
        try cache.write(Data(SummaryFixtures.sampleJSON.utf8))
        let read = try #require(cache.read())
        #expect(read.summary == SummaryFixtures.sample)
    }

    @Test func fetchedAtIsFileModificationDate() throws {
        let cache = SummaryCache(directory: tempDir())
        defer { if let d = cache.directory { try? FileManager.default.removeItem(at: d) } }
        try cache.write(Data(SummaryFixtures.sampleJSON.utf8))
        let url = try #require(cache.fileURL)
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)
        try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: url.path)
        #expect(cache.read()?.fetchedAt == stamp)
    }

    @Test func readIsNilForMissingDirectoryFileAndGarbage() throws {
        #expect(SummaryCache(directory: nil).read() == nil)
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = SummaryCache(directory: dir)
        #expect(cache.read() == nil)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: try #require(cache.fileURL))
        #expect(cache.read() == nil)
    }

    @Test func writeRejectsGarbageAndNilDirectory() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(throws: (any Error).self) { try SummaryCache(directory: dir).write(Data("nope".utf8)) }
        #expect(throws: (any Error).self) { try SummaryCache(directory: nil).write(Data(SummaryFixtures.sampleJSON.utf8)) }
        #expect(SummaryCache(directory: dir).read() == nil)
    }

    @Test func fileURLUsesSharedFileName() {
        let dir = URL(fileURLWithPath: "/tmp/demo")
        #expect(SummaryCache(directory: dir).fileURL?.lastPathComponent == "summary.json")
        #expect(SummaryCache(directory: nil).fileURL == nil)
    }
}
