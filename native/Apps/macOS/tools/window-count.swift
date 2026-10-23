// Counts the on-screen, layer-0 windows a process owns, without the Screen Recording permission (owner and
// bounds are readable without it; titles are not). usage: swift tools/window-count.swift <pid> [-v]
// Prints the count; -v adds one line per window (bounds). Used to prove the macOS app keeps one main window.
import CoreGraphics
import Foundation

let args = CommandLine.arguments.dropFirst()
guard let pid = args.first.flatMap({ Int32($0) }) else {
    FileHandle.standardError.write(Data("usage: window-count.swift <pid> [-v]\n".utf8))
    exit(2)
}
let verbose = args.contains("-v")
let all = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
let mine = all.filter {
    ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
}
print(mine.count)
if verbose {
    for w in mine {
        let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
        print("  window \(w[kCGWindowNumber as String] ?? "?") \(b["Width"] ?? 0)x\(b["Height"] ?? 0) at \(b["X"] ?? 0),\(b["Y"] ?? 0)")
    }
}
