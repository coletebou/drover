// swift-tools-version: 6.0
// Pure-Foundation core of the widgets (model, cache, fetch, deep links). The WidgetKit targets in
// project.part.yml compile these same sources directly (no module import), so this package exists for `swift test`.
import PackageDescription

let package = Package(
    name: "DroverWidgetCore",
    platforms: [.macOS(.v14), .iOS(.v17), .watchOS(.v10)],
    products: [.library(name: "DroverWidgetCore", targets: ["DroverWidgetCore"])],
    targets: [
        .target(name: "DroverWidgetCore", path: "Core"),
        .testTarget(name: "DroverWidgetCoreTests", dependencies: ["DroverWidgetCore"], path: "Tests/DroverWidgetCoreTests"),
    ]
)
