import AppKit
import SafariServices
import SwiftUI

/// The embedded Safari web extension (Extensions/safari): whether Safari has it turned on, and a way there.
/// The extension has no settings of its own. It uses this app's server and token, and this app answers
/// Reply and Open on the notifications it posts.
struct SafariSettingsView: View {
    @State private var enabled: Bool?

    private var extensionID: String {
        Bundle.main.object(forInfoDictionaryKey: "DroverSafariExtensionBundleID") as? String ?? ""
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Drover extension") {
                    HStack {
                        Text(stateText).foregroundStyle(enabled == true ? Theme.moss : Theme.ink3)
                        Button("Open Safari Settings") {
                            let id = extensionID
                            Task { await Self.showPreferences(id: id) }
                        }
                        .disabled(extensionID.isEmpty)
                    }
                }
            } footer: {
                Text("In Safari, turn on Drover under Settings > Extensions and allow it on the sites you want. It uses the server and token from the Connection tab.")
            }
        }
        .formStyle(.grouped)
        .task { await refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await refresh() }
        }
    }

    private var stateText: String {
        switch enabled {
        case .some(true): return "On"
        case .some(false): return "Off"
        case .none: return "Unknown"
        }
    }

    private func refresh() async {
        enabled = await Self.extensionState(id: extensionID)
    }

    // SafariServices answers on an XPC queue. A callback this main-actor view hands it inherits the main actor,
    // and Swift 6 traps when it runs on that queue (the old Drover for Safari app crashed at launch that way).
    // So these helpers are nonisolated and use the async forms; only a Bool, or nothing, comes back.
    nonisolated private static func extensionState(id: String) async -> Bool? {
        guard !id.isEmpty else { return nil }
        return try? await SFSafariExtensionManager.stateOfSafariExtension(withIdentifier: id).isEnabled
    }

    nonisolated private static func showPreferences(id: String) async {
        try? await SFSafariApplication.showPreferencesForExtension(withIdentifier: id)
    }
}
