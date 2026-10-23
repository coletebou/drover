// swift-tools-version: 6.0
// DroverKit: the shared client for Drover (models, HTTP client, SSE stream, stores, Keychain, mocks).
// Used by every Apple target in Drover native. Swift 6 language mode, no dependencies.
import PackageDescription

let package = Package(
    name: "DroverKit",
    platforms: [.iOS(.v17), .macOS(.v14), .watchOS(.v10)],
    products: [
        .library(name: "DroverKit", targets: ["DroverKit"]),
    ],
    targets: [
        .target(name: "DroverKit", swiftSettings: [.swiftLanguageMode(.v6)]),
        .testTarget(name: "DroverKitTests", dependencies: ["DroverKit"], swiftSettings: [.swiftLanguageMode(.v6)]),
    ]
)
