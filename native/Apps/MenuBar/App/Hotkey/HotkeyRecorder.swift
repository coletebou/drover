import AppKit
import SwiftUI

/// Click to record a global shortcut; shows the current one; a clear button sets it to nil.
struct HotkeyRecorder: View {
    @Binding var combo: KeyCombo?
    @State private var recording = false
    @State private var hint: String?
    @State private var monitor: Any?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(recording ? "Type a shortcut" : (combo?.displayString ?? "Not set"))
                    .monospacedDigit()
                    .foregroundStyle(recording || combo == nil ? .secondary : .primary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .frame(minWidth: 120, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(Color(nsColor: .controlBackgroundColor)))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(recording ? Color.accentColor : Color.secondary.opacity(0.4), lineWidth: 1))
                Button(recording ? "Cancel" : "Record") {
                    recording ? stop() : start()
                }
                if combo != nil, !recording {
                    Button {
                        combo = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear shortcut")
                }
            }
            if let hint {
                Text(hint).font(.caption).foregroundStyle(.secondary)
            }
        }
        .onDisappear { stop() }
    }

    private func start() {
        stop()
        hint = nil
        recording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            handle(event) ? nil : event
        }
    }

    private func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        recording = false
    }

    /// Returns true when the event was consumed.
    private func handle(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let hasModifiers = !flags.intersection([.command, .option, .control, .shift]).isEmpty
        if event.keyCode == 53 {  // Esc
            hint = nil
            stop()
            return true
        }
        if (event.keyCode == 51 || event.keyCode == 117) && !hasModifiers {  // Delete, forward delete
            combo = nil
            hint = nil
            stop()
            return true
        }
        guard let candidate = KeyCombo(keyCode: event.keyCode, cocoaModifierFlags: flags.rawValue) else {
            return true
        }
        guard candidate.isValidGlobalShortcut else {
            hint = "Use Command, Option or Control with a key."
            return true
        }
        combo = candidate
        hint = nil
        stop()
        return true
    }
}
