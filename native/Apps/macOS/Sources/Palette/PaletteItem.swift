import SwiftUI
import AppKit

struct PaletteItem: Identifiable {
    enum Kind: Int {
        case session, view, tab, key, action
        var label: String {
            switch self {
            case .session: "Session"
            case .view: "View"
            case .tab: "Tab"
            case .key: "Key"
            case .action: "Action"
            }
        }
    }

    let id: String
    let title: String
    let subtitle: String?
    let kind: Kind
    let tint: Color?
    let symbol: String
    let perform: @MainActor (AppModel) -> Void
    /// True for sessions in the waiting lane (listed first on an empty query).
    var isWaiting = false
}

@MainActor
enum PaletteCatalog {
    static func items(for model: AppModel) -> [PaletteItem] {
        var out: [PaletteItem] = []
        let selected = model.selectedSession

        for s in model.board.sessions {
            var sub = "\(s.host) · \(s.engine) · \(s.lane.title)"
            if let h = s.headline, !h.isEmpty {
                sub += " · " + (h.count > 60 ? String(h.prefix(59)) + "…" : h)
            }
            out.append(PaletteItem(
                id: "session:\(s.key)", title: s.name, subtitle: sub, kind: .session,
                tint: s.isManager ? Theme.lilac : Theme.color(for: s.lane),
                symbol: s.isManager ? "person.crop.circle" : "terminal",
                perform: { m in
                    if !m.visibleSessions.contains(s) { m.sidebarSelection = .all }
                    m.select(s)
                    m.detailTab = .chat
                }, isWaiting: s.lane == .waiting))
        }

        let views: [(String, String, SidebarItem, Color?)] = [
            ("Show all sessions", "view:all", .all, nil),
            ("Show waiting on you", "view:waiting", .lane(.waiting), Theme.amber),
            ("Show working", "view:working", .lane(.working), Theme.steel),
            ("Show idle", "view:idle", .lane(.idle), Theme.moss),
            ("Show manager", "view:manager", .manager, Theme.lilac),
        ]
        out.append(PaletteItem(id: "action:manager-panel", title: "Toggle the floating manager", subtitle: "Shift Command M", kind: .action,
                               tint: Theme.lilac, symbol: "macwindow.on.rectangle", perform: { _ in WindowRouter.shared.toggleManagerPanel() }))
        for p in ManagerModel.quickPrompts {
            out.append(PaletteItem(id: "manager:\(p.title)", title: "Ask the manager: \(p.title)", subtitle: nil, kind: .action,
                                   tint: Theme.lilac, symbol: "person.crop.circle", perform: { m in
                                       m.showManagerInWindow()
                                       m.manager.send(p.text)
                                   }))
        }
        var viewItems = views.map { v in
            PaletteItem(id: v.1, title: v.0, subtitle: nil, kind: .view, tint: v.3, symbol: "sidebar.left",
                        perform: { $0.sidebarSelection = v.2 })
        }
        for h in model.board.hosts {
            let name = h.name
            viewItems.append(PaletteItem(id: "view:host:\(name)", title: "Show host \(name)", subtitle: nil, kind: .view,
                                         tint: nil, symbol: "desktopcomputer", perform: { $0.sidebarSelection = .host(name) }))
        }

        if let s = selected {
            for t in [("Open chat", DetailTab.chat, "bubble.left"), ("Open screen", .screen, "rectangle.on.rectangle"),
                      ("Open info", .info, "info.circle")] {
                out.append(PaletteItem(id: "tab:\(t.1.rawValue)", title: t.0, subtitle: s.name, kind: .tab, tint: nil,
                                       symbol: t.2, perform: { $0.detailTab = t.1 }))
            }
            if let state = model.dialogState(s) {
                // The dialog's own keys, answered only on the screen they were read from.
                for b in DialogKeys.buttons(dialog: state.dialog, keys: state.keys, held: state.held) {
                    out.append(PaletteItem(id: "answer:\(b.key)", title: "Answer \(s.name): \(b.label)", subtitle: state.dialog?.question,
                                           kind: .key, tint: Theme.amber, symbol: "hand.raised",
                                           perform: { m in Task { await m.answer(s, key: b.key) } }))
                }
            } else if let target = s.tmuxTarget {
                for k in PaneKey.basic {
                    out.append(PaletteItem(id: "key:\(k.rawValue)", title: "Press \(k.label) in \(s.name)", subtitle: "\(s.host) · \(target)",
                                           kind: .key, tint: nil, symbol: "keyboard",
                                           perform: { m in m.press(k, in: s) }))
                }
            }
            out.append(PaletteItem(id: "action:reply", title: "Reply to \(s.name)", subtitle: nil, kind: .action, tint: nil,
                                   symbol: "arrowshape.turn.up.left", perform: { $0.focusComposer() }))
            let sid = s.id
            out.append(PaletteItem(id: "action:copy-id", title: "Copy session id", subtitle: sid, kind: .action, tint: nil,
                                   symbol: "doc.on.doc", perform: { _ in
                                       NSPasteboard.general.clearContents()
                                       NSPasteboard.general.setString(sid, forType: .string)
                                   }))
        }
        out.append(PaletteItem(id: "action:refresh", title: "Refresh board", subtitle: nil, kind: .action, tint: nil,
                               symbol: "arrow.clockwise", perform: { m in Task { await m.refresh() } }))
        out.append(PaletteItem(id: "action:settings", title: "Open settings", subtitle: nil, kind: .action, tint: nil,
                               symbol: "gearshape", perform: { _ in
                                   NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                               }))
        return out + viewItems
    }

    static func search(_ query: String, in items: [PaletteItem]) -> [PaletteItem] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.isEmpty {
            let waiting = items.filter { $0.kind == .session && $0.isWaiting }
            let waitingIDs = Set(waiting.map(\.id))
            let rest = items.filter { !waitingIDs.contains($0.id) }
            // items() already lists sessions first (board order), then tabs, keys, actions, views.
            let sessions = rest.filter { $0.kind == .session }
            let others = [PaletteItem.Kind.tab, .key, .action, .view].flatMap { k in rest.filter { $0.kind == k } }
            return Array((waiting + sessions + others).prefix(50))
        }
        let scored: [(PaletteItem, Int)] = items.compactMap { item in
            let t = FuzzyMatch.score(q, in: item.title)
            let s = item.subtitle.flatMap { FuzzyMatch.score(q, in: $0) }.map { $0 / 2 }
            guard let best = [t, s].compactMap({ $0 }).max() else { return nil }
            return (item, best)
        }
        let sorted = scored.sorted {
            if $0.1 != $1.1 { return $0.1 > $1.1 }
            if $0.0.kind.rawValue != $1.0.kind.rawValue { return $0.0.kind.rawValue < $1.0.kind.rawValue }
            return $0.0.title < $1.0.title
        }
        return Array(sorted.prefix(50).map(\.0))
    }
}
