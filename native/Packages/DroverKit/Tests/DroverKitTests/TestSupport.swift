import Foundation
@testable import DroverKit

enum TestFixtures {
    // Tests/DroverKitTests/TestSupport.swift -> repo root is five levels up from the file.
    static let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appending(path: "Fixtures")

    static func data(_ name: String) throws -> Data { try Data(contentsOf: dir.appending(path: name)) }

    static func summary() throws -> NativeSummary {
        try JSONDecoder().decode(NativeSummary.self, from: data("native-summary.json"))  // bare result
    }

    static func notifications() throws -> NativeNotifications {
        try JSONDecoder().decode(OpEnvelope<NativeNotifications>.self, from: data("native.notifications.json")).result!
    }
}
