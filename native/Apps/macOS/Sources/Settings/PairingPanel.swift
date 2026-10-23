import AppKit
import DroverKit
import SwiftUI

/// The code to approve and how pairing went (`AppModel.pairing`). Settings > Connection and the board's empty
/// state show it; nothing while idle.
struct PairingStatus: View {
    @Environment(AppModel.self) private var model
    /// The board's empty state centres it.
    var centered = false

    var body: some View {
        switch model.pairing.phase {
        case .idle:
            EmptyView()
        case .requesting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Asking the daemon for a pairing code...")
            }
            .foregroundStyle(Theme.ink3)
        case .waiting(let code, let expiresAt):
            VStack(alignment: centered ? .center : .leading, spacing: 6) {
                Text(PairingCode.formatted(code))
                    .font(.system(size: 34, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .accessibilityLabel("Pairing code \(PairingCode.spoken(code))")
                Text(Self.markdown(PairingCode.instructions(code)))
                    .foregroundStyle(Theme.ink2)
                    .multilineTextAlignment(centered ? .center : .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                let now = Date.now
                HStack(spacing: 4) {
                    Text("Expires in")
                    Text(timerInterval: now...max(now, expiresAt), countsDown: true).monospacedDigit()
                }
                .font(.caption).foregroundStyle(Theme.ink3)
                .accessibilityElement(children: .combine)
            }
        case .paired:
            Label("Paired. Both tokens are in your Keychain.", systemImage: "checkmark.circle.fill")
                .foregroundStyle(Theme.moss)
        case .denied:
            Label("The pairing request was denied.", systemImage: "xmark.octagon.fill")
                .foregroundStyle(Theme.brick)
        case .expired:
            Label("The code expired before anyone approved it.", systemImage: "clock.badge.exclamationmark")
                .foregroundStyle(Theme.brick)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.brick)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The instructions put the command in backticks: render it as code.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text)) ?? AttributedString(text)
    }
}

/// Pair, or Cancel while a code is showing, plus Copy command and Open browser UI (the two ways to approve).
struct PairingButtons: View {
    enum Part { case all, approve, control }

    @Environment(AppModel.self) private var model
    /// `approve`: Copy command and Open browser UI, only while a code is showing. `control`: Pair, Try again or Cancel.
    var part = Part.all

    var body: some View {
        let phase = model.pairing.phase
        if part != .control, let code = phase.code {
            Button("Copy command") { Self.copy(PairingCode.approveCommand(code)) }
                .help("Copies \(PairingCode.approveCommand(code)) to paste into Terminal")
            if let url = model.pairing.serverURL {
                Button("Open browser UI") { NSWorkspace.shared.open(url) }
                    .help("Opens Drover's browser UI, where Approve is")
            }
        }
        if part != .approve {
            if phase.isActive {
                Button("Cancel") { model.pairing.cancel() }
            } else {
                Button(Self.startTitle(phase)) { model.startPairing() }
                    .disabled(model.settings.serverURL == nil)
            }
        }
    }

    static func startTitle(_ phase: PairingPhase) -> String {
        switch phase {
        case .denied, .expired, .failed: "Try again"
        default: "Pair with this daemon"
        }
    }

    private static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// A `drover://pair?url=` link (`AppModel.pairLink`): the address it names, and pairing with it only on a click (with
/// the daemon in use, it has started already: PairLinkPolicy). The code and the ways to approve it show here. Pair is
/// not the default button: a stray Return never accepts another server.
struct PairLinkSheet: View {
    @Environment(AppModel.self) private var model
    let url: URL

    /// The pairing in the controller is this link's (Settings may have started another).
    private var ours: Bool { model.pairing.serverURL == url }
    private var phase: PairingPhase { ours ? model.pairing.phase : .idle }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pair with \(url.host() ?? url.absoluteString)?")
                .font(.headline).foregroundStyle(Theme.ink)
            Text(PairLinkPolicy.confirmation(for: url, current: model.settings.serverURL))
                .foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if ours { PairingStatus() }
            HStack(spacing: 10) {
                if ours { PairingButtons(part: .approve) }
                Spacer()
                if phase == .paired {
                    Button("Done") { model.dismissPairLink() }.keyboardShortcut(.defaultAction)
                } else {
                    Button("Cancel", role: .cancel) { model.dismissPairLink() }.keyboardShortcut(.cancelAction)
                    if !phase.isActive {
                        Button(PairingButtons.startTitle(phase)) { model.confirmPairLink() }
                    }
                }
            }
            .font(.callout)
        }
        .padding(20)
        .frame(width: 460)
        .background(Theme.bg2)
    }
}
