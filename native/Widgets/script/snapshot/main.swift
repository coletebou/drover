import AppKit
import SwiftUI
import WidgetKit

// script/snapshot.sh: the home-screen and desktop widgets on synthetic data (CONTRACT.md: no company data), offscreen,
// as one picture per appearance: the medium and two small widgets beside the large one. Outside WidgetKit the
// family cannot be set (EnvironmentValues.widgetFamily is read-only) and containerBackground draws nothing, so each
// family's view is drawn directly on the widget's own background, with the system's content margins.

/// The sample summary with its times moved to just before the render (the fixed dates read "13 days" in a picture).
func recent(_ s: NativeSummary, now: Date = Date()) -> NativeSummary {
    let shift = now.timeIntervalSince(s.generatedAt ?? now)
    var r = s
    r.generatedAt = now
    r.waiting = s.waiting.map { var w = $0; w.since = w.since?.addingTimeInterval(shift); return w }
    if var m = r.manager { m.lastNoteAt = m.lastNoteAt?.addingTimeInterval(shift); r.manager = m }
    return r
}

/// One widget as the desktop draws it: its family's size, the system margins, a continuous-corner background.
struct WidgetFrame<Content: View>: View {
    var size: CGSize
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(14)
            .frame(width: size.width, height: size.height)
            .background(DroverPalette.bg, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
    }
}

struct Gallery: View {
    var sample: SummaryEntry
    var quiet: SummaryEntry
    static let small = CGSize(width: 170, height: 170), medium = CGSize(width: 364, height: 170), large = CGSize(width: 364, height: 382)
    var body: some View {
        HStack(alignment: .top, spacing: 24) {
            VStack(alignment: .leading, spacing: 24) {
                WidgetFrame(size: Self.medium) { MediumSummaryView(entry: sample) }
                HStack(spacing: 24) {
                    WidgetFrame(size: Self.small) { SmallSummaryView(entry: sample) }
                    WidgetFrame(size: Self.small) { SmallSummaryView(entry: quiet) }
                }
            }
            WidgetFrame(size: Self.large) { LargeSummaryView(entry: sample) }
        }
        .padding(32)
    }
}

@MainActor
func spin(_ view: NSView) { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)); view.layoutSubtreeIfNeeded() }

@MainActor
func render<V: View>(_ view: V, dark: Bool, to url: URL) async {
    let host = NSHostingView(rootView: view)
    host.frame = CGRect(origin: .zero, size: host.fittingSize)
    let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
    window.backgroundColor = .clear
    window.contentView = host
    for _ in 0..<20 { try? await Task.sleep(for: .milliseconds(25)); spin(host) }
    host.frame = CGRect(origin: .zero, size: host.fittingSize)
    spin(host)
    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
    host.cacheDisplay(in: host.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: url)
}

@main
struct SnapshotMain {
    @MainActor
    static func main() async {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let out = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".build/widget-snapshots")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let sample = SummaryEntry(date: .now, summary: recent(SummaryFixtures.sample), hostFilter: nil, status: .live)
        let quiet = SummaryEntry(date: .now, summary: recent(SummaryFixtures.empty), hostFilter: "demo-mac", status: .live)
        for dark in [false, true] {
            let url = out.appendingPathComponent("widgets-\(dark ? "dark" : "light").png")
            await render(Gallery(sample: sample, quiet: quiet), dark: dark, to: url)
            print("wrote \(url.path)")
        }
        exit(0)
    }
}
