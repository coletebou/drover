import AppKit
import SwiftUI

/// Live tmux pane for a session: captured about every 1.5 s while visible (and the window is on screen), drawn by an
/// NSTextView (no wrapping by default, horizontal scroll) that keeps your scroll position unless you are at the
/// bottom. Each capture is also the session's newest screen reading (AppModel.note), so the answer bar here, the
/// card in Chat and the board row all show the dialog that is really up.
struct ScreenView: View {
    let session: SessionItem
    @Environment(AppModel.self) private var model
    @State private var capture: ScreenCapture?
    @State private var errorText: String?
    @AppStorage("drover.screenWrap") private var wrap = false

    static let pollSeconds = 1.5

    var body: some View {
        if let target = session.tmuxTarget {
            VStack(spacing: 0) {
                topBar(target)
                Divider().overlay(Theme.line)
                if let errorText {
                    Text(errorText).font(.caption).foregroundStyle(Theme.brick)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16).padding(.vertical, 6)
                        .background(Theme.wash(Theme.brick))
                }
                if model.showsAnswerCard(session) {
                    DialogAnswerView(session: session, style: .bar)
                    Divider().overlay(Theme.line)
                }
                PaneTextView(text: capture?.text ?? "", wrap: wrap)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.bg2)
                    .accessibilityLabel("Pane \(target)")
            }
            // Restarts on another session or after a key press (a capture right away), never per server event.
            .task(id: "\(session.key)#\(model.screenPoke)") { await poll(target: target) }
        } else {
            ContentUnavailableView("No pane", systemImage: "terminal",
                                   description: Text("This session has no tmux pane to show."))
        }
    }

    private func poll(target: String) async {
        let service = model.service
        while !Task.isCancelled {
            if model.isMainWindowVisible {
                let t0 = PerfLog.now()
                do {
                    let c = try await service.capture(target: target, host: session.host, lines: 200)
                    if c != capture { capture = c }
                    // The daemon's classification, the dialog read the way it reads it (same hash for a press).
                    model.note(reading: ScreenDialog.read(capture: c), for: session)
                    errorText = nil
                    PerfLog.log("screen capture", since: t0, "\(c.text.utf8.count / 1024) KB")
                } catch is CancellationError {
                    return
                } catch {
                    if Task.isCancelled { return }
                    errorText = error.localizedDescription
                }
            }
            do { try await Task.sleep(for: .seconds(Self.pollSeconds)) } catch { return }
        }
    }

    private func topBar(_ target: String) -> some View {
        let badge = Self.badge(for: capture?.state ?? session.screen)
        return HStack(spacing: 8) {
            Text(badge.text)
                .font(.caption.weight(.medium)).foregroundStyle(badge.color)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(Capsule().fill(Theme.wash(badge.color)))
            if let r = capture?.reason {
                Text(r).font(.caption).foregroundStyle(Theme.ink3).lineLimit(1)
            }
            Spacer()
            Toggle("Wrap", isOn: $wrap)
                .toggleStyle(.checkbox).controlSize(.small)
                .help("Wrap long lines")
            Text(target).font(Theme.mono).foregroundStyle(Theme.ink3).textSelection(.enabled)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    static func badge(for state: ScreenState) -> (text: String, color: Color) {
        switch state {
        case .dialog: ("Dialog on screen", Theme.amber)
        case .busy: ("Working", Theme.steel)
        case .idle: ("Idle", Theme.moss)
        case .unknown: ("Unknown", Theme.ink3)
        }
    }
}

/// Monospaced, read-only, selectable pane text. Setting a new capture costs one text storage replace (no SwiftUI
/// relayout of hundreds of long lines); the scroll position stays unless you were at the bottom, where it follows.
struct PaneTextView: NSViewRepresentable {
    var text: String
    var wrap: Bool

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = Theme.nsBg2
        guard let tv = scroll.documentView as? NSTextView else { return scroll }
        tv.isEditable = false
        tv.isSelectable = true
        tv.isRichText = false
        tv.usesFontPanel = false
        tv.drawsBackground = true
        tv.backgroundColor = Theme.nsBg2
        tv.textColor = Theme.nsInk
        tv.selectedTextAttributes = [.backgroundColor: Theme.nsSelection]
        tv.font = Self.font
        tv.textContainerInset = NSSize(width: 10, height: 10)
        tv.isAutomaticLinkDetectionEnabled = false
        tv.layoutManager?.allowsNonContiguousLayout = true
        apply(wrap: wrap, to: tv, in: scroll)
        context.coordinator.wrap = wrap
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        if context.coordinator.wrap != wrap {
            context.coordinator.wrap = wrap
            apply(wrap: wrap, to: tv, in: scroll)
        }
        guard context.coordinator.text != text else { return }
        let first = context.coordinator.text == nil
        context.coordinator.text = text
        let clip = scroll.contentView
        let docHeight = tv.frame.height
        let wasAtBottom = first || clip.bounds.maxY >= docHeight - 24
        let origin = clip.bounds.origin
        tv.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: [
            .font: Self.font, .foregroundColor: Theme.nsInk,
        ]))
        if wasAtBottom {
            tv.scrollToEndOfDocument(nil)
        } else {
            tv.layoutManager?.ensureLayout(for: tv.textContainer!)
            clip.scroll(to: origin)
            scroll.reflectScrolledClipView(clip)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var text: String?
        var wrap = false
    }

    static let font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)

    private func apply(wrap: Bool, to tv: NSTextView, in scroll: NSScrollView) {
        guard let container = tv.textContainer else { return }
        if wrap {
            tv.isHorizontallyResizable = false
            container.widthTracksTextView = true
            container.containerSize = NSSize(width: scroll.contentSize.width, height: .greatestFiniteMagnitude)
            tv.frame.size.width = scroll.contentSize.width
        } else {
            tv.isHorizontallyResizable = true
            tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
            container.widthTracksTextView = false
            container.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        }
        scroll.hasHorizontalScroller = !wrap
    }
}
