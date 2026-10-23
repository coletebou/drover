import SwiftUI

/// Menu bar commands (Cmd+K palette, refresh, tabs, dialog answers, pane keys, the manager).
struct AppCommands: Commands {
    let model: AppModel

    private var selected: SessionItem? { model.selectedSession }
    private var hasSelection: Bool { selected != nil }
    private var hasPane: Bool { selected?.tmuxTarget != nil }

    var body: some Commands {
        CommandMenu("Session") {
            Button("Command palette") { model.isPaletteOpen.toggle() }
                .keyboardShortcut("k", modifiers: .command)
            Button("Refresh") { Task { await model.refresh() } }
                .keyboardShortcut("r", modifiers: .command)
            Divider()
            Button("Next session") { model.selectNext() }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
            Button("Previous session") { model.selectPrevious() }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            Button("Reply") { model.focusComposer() }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(!hasSelection && !model.showsManager)
            Divider()
            Button("Chat") { model.detailTab = .chat }
                .keyboardShortcut("1", modifiers: .command).disabled(!hasSelection)
            Button("Screen") { model.detailTab = .screen }
                .keyboardShortcut("2", modifiers: .command).disabled(!hasSelection)
            Button("Info") { model.detailTab = .info }
                .keyboardShortcut("3", modifiers: .command).disabled(!hasSelection)
            Divider()
            Menu("Answer the dialog") {
                if let s = selected, let state = model.dialogState(s) {
                    ForEach(DialogKeys.buttons(dialog: state.dialog, keys: state.keys, held: state.held)) { b in
                        Button(b.label) { Task { await model.answer(s, key: b.key) } }
                    }
                }
            }
            .disabled(!(selected.map(model.showsAnswerCard) ?? false))
            Menu("Press in pane") {
                if let s = selected {
                    ForEach(PaneKey.basic) { key in
                        Button(key.spokenName) { model.press(key, in: s) }
                    }
                }
            }
            .disabled(!hasPane)
        }
        CommandGroup(after: .sidebar) {
            Divider()
            Button("Manager") { model.showManagerInWindow() }
                .keyboardShortcut("0", modifiers: [.command, .control])
            Button("All sessions") { model.sidebarSelection = .all }
                .keyboardShortcut("1", modifiers: [.command, .control])
            Button("Waiting on you") { model.sidebarSelection = .lane(.waiting) }
                .keyboardShortcut("2", modifiers: [.command, .control])
            Button("Working") { model.sidebarSelection = .lane(.working) }
                .keyboardShortcut("3", modifiers: [.command, .control])
            Button("Idle") { model.sidebarSelection = .lane(.idle) }
                .keyboardShortcut("4", modifiers: [.command, .control])
            Divider()
            Button("Manager panel") { WindowRouter.shared.toggleManagerPanel() }
                .keyboardShortcut("m", modifiers: [.command, .shift])
        }
    }
}
