// swift-tools-version: 6.0
// MenuBarCore: the menu bar app's pure logic (models, client, polling, SSE, preferences, hotkey
// parsing). The same sources are compiled straight into the DroverMenuBar app target by XcodeGen
// (see project.part.yml), so app files never `import MenuBarCore`. This package exists so the
// logic can be tested with `swift test` without Xcode.
import PackageDescription

let package = Package(
    name: "MenuBarCore",
    platforms: [.macOS(.v14)],
    products: [.library(name: "MenuBarCore", targets: ["MenuBarCore"])],
    targets: [
        .target(name: "MenuBarCore", path: "Sources/MenuBarCore"),
        .testTarget(
            name: "MenuBarCoreTests",
            dependencies: ["MenuBarCore"],
            path: "Tests/MenuBarCoreTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
