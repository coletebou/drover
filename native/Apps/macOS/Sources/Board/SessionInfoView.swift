import SwiftUI
import AppKit

/// Facts about one session, with copy actions.
struct SessionInfoView: View {
    let session: SessionItem

    var body: some View {
        Form {
            Section {
                row("Name") { Text(session.name) }
                row("Id") {
                    HStack {
                        Text(session.id).font(Theme.mono).textSelection(.enabled)
                        Button("Copy") { Self.copy(session.id) }.controlSize(.small)
                    }
                }
                row("Host") { Text(session.host).font(Theme.mono) }
                row("Engine") { Text(session.engine) }
                row("Status") { Text(session.status) }
                row("Lane") { Text(session.lane.title) }
                if let k = session.waitKind { row("Waiting reason") { Text(k.label) } }
                if let h = session.headline, !h.isEmpty { row("Headline") { Text(h) } }
                if let cwd = session.cwd { row("Working directory") { Text(cwd).font(Theme.mono).textSelection(.enabled) } }
                if let t = session.tmuxTarget { row("tmux target") { Text(t).font(Theme.mono).textSelection(.enabled) } }
                if let u = session.updatedAt {
                    row("Updated") {
                        Text("\(BoardFormat.relative(u)) · \(u.formatted(date: .abbreviated, time: .standard))")
                    }
                }
                row("Live") { Text(session.live ? "Yes" : "No") }
            }
            Section {
                HStack {
                    Button("Copy id") { Self.copy(session.id) }
                    Button("Copy Drover link") { Self.copy(BoardFormat.droverLink(for: session).absoluteString) }
                }
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
    }

    private func row<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        LabeledContent {
            content().foregroundStyle(Theme.ink).frame(maxWidth: .infinity, alignment: .trailing)
        } label: {
            Text(label).foregroundStyle(Theme.ink3)
        }
    }

    static func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }
}
