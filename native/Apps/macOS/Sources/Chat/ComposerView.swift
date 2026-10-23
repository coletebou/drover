import SwiftUI
import UniformTypeIdentifiers

/// Composer: send to session vs to pane, key buttons, file drop -> uploads.put. The keys are the dialog's own when one
/// is up (pressed through `sessions.answer`, so only on the screen they were drawn from), else Enter, Esc, Ctrl-C and
/// the arrows for the pane (`tmux.keys`).
struct ComposerView: View {
    let session: SessionItem
    @Environment(AppModel.self) private var model

    enum SendTarget: String, Hashable { case session, pane }
    struct Notice: Equatable {
        enum Kind { case info, warning, error }
        var kind: Kind
        var text: String
        var offersForce = false
    }

    @State private var text = ""
    /// Bumped on every edit, so a finished send clears the editor only if nothing was typed meanwhile.
    @State private var editRevision = 0
    @State private var target: SendTarget = .session
    @FocusState private var focused: Bool
    @State private var attachments: [Attachment] = []
    @State private var notice: Notice?
    @State private var sending = false
    @State private var uploadsSupported = false
    @State private var importing = false

    /// TextEditor is greedy, so size it from the line count: 44 to 160 pt.
    private var editorHeight: CGFloat {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).count
        return min(160, max(44, CGFloat(lines) * 20 + 14))
    }
    private var hasPane: Bool { session.tmuxTarget != nil }
    private var readyPaths: [String] { attachments.compactMap(\.readyPath) }
    private var canSend: Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // Wait for uploads: sending now would silently leave the pending files out of the message.
        let uploading = attachments.contains { $0.status == .uploading }
        return (hasText || !readyPaths.isEmpty) && !sending && !uploading
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            topRow
            if let notice { noticeView(notice) }
            if !attachments.isEmpty { chips }
            HStack(alignment: .bottom, spacing: 8) {
                editor
                VStack(spacing: 6) {
                    Button { importing = true } label: { Image(systemName: "paperclip") }
                        .disabled(!uploadsSupported)
                        .help(uploadsSupported ? "Attach files" : "This daemon has no upload op")
                    Button { send() } label: { Image(systemName: "paperplane.fill") }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!canSend)
                        .help("Send (Return)")
                }
                .buttonStyle(.bordered).controlSize(.regular)
            }
        }
        .padding(12)
        .background(Theme.bg)
        .onAppear {
            if session.windowOnly && hasPane { target = .pane }
            // No focus grab here: a focused editor swallows the board's j/k/r keys. Focus comes from
            // `model.focusComposer()` (r, Reply, notification reply) or a click.
            text = model.composerDraft[session.key] ?? ""
        }
        .task(id: session.key) {
            uploadsSupported = await model.service.supportsUploads()
        }
        .onChange(of: text) { _, new in
            editRevision &+= 1
            if new.isEmpty { model.composerDraft.removeValue(forKey: session.key) }
            else { model.composerDraft[session.key] = new }
        }
        .onChange(of: model.composerFocusRequest) { _, _ in
            if let draft = model.composerDraft[session.key] { text = draft }
            focused = true
        }
        .onChange(of: session.key) { _, _ in
            text = model.composerDraft[session.key] ?? ""
            attachments = []; notice = nil
            if !hasPane { target = .session }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image, .pdf, .plainText, .data],
                      allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): addFiles(urls)
            case .failure(let err): notice = Notice(kind: .error, text: err.localizedDescription)
            }
        }
    }

    // MARK: pieces

    private var topRow: some View {
        HStack(spacing: 8) {
            Picker("Send to", selection: $target) {
                Text("Session").tag(SendTarget.session)
                Text("Pane").tag(SendTarget.pane)
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 150)
            .help(hasPane ? "Send to the session or paste into its tmux pane" : "This session has no tmux pane")
            .onChange(of: hasPane) { _, has in if !has { target = .session } }
            .onChange(of: target) { _, new in
                if new == .pane && !hasPane { target = .session }
                if new == .session && session.windowOnly && hasPane { target = .pane }
            }
            Spacer(minLength: 8)
            if let state = model.dialogState(session) {
                ForEach(DialogKeys.buttons(dialog: state.dialog, keys: state.keys, held: state.held)) { b in
                    Button(b.kind == .option ? b.key : b.label) { answer(b.key) }
                        .buttonStyle(.bordered).controlSize(.small)
                        .disabled(model.answering[session.key] != nil)
                        .help(b.kind == .option ? "Pick \(b.label)" : "Press \(b.label) on the dialog")
                }
            } else {
                ForEach(PaneKey.basic) { key in
                    Button(key.label) { press(key) }
                        .buttonStyle(.bordered).controlSize(.small)
                        .disabled(!hasPane)
                        .help(hasPane ? "Press \(key.spokenName) in the pane" : "This session has no tmux pane")
                        .accessibilityLabel("Press \(key.spokenName)")
                }
            }
        }
    }

    private var editor: some View {
        let base = ZStack(alignment: .topLeading) {
            TextEditor(text: $text)
                .font(.body)
                .scrollContentBackground(.hidden)
                .focused($focused)
                .padding(.horizontal, 4).padding(.vertical, 4)
                .onKeyPress(.escape) {
                    focused = false
                    NSApp.keyWindow?.makeFirstResponder(nil)
                    return .handled
                }
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    send()
                    return .handled
                }
            if text.isEmpty {
                Text("Message \(session.name)")
                    .foregroundStyle(Theme.ink4)
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .allowsHitTesting(false)
            }
        }
        .frame(height: editorHeight)
        .background(Theme.bg2, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
        return Group {
            if uploadsSupported {
                base.dropDestination(for: URL.self) { urls, _ in
                    let files = urls.filter(\.isFileURL)
                    guard !files.isEmpty else { return false }
                    addFiles(files)
                    return true
                }
            } else {
                base
            }
        }
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { a in
                    HStack(spacing: 5) {
                        switch a.status {
                        case .uploading: ProgressView().controlSize(.mini)
                        case .ready: Image(systemName: "checkmark").foregroundStyle(Theme.moss)
                        case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.brick)
                        }
                        Text(a.name).font(Theme.mono).foregroundStyle(Theme.ink2).lineLimit(1)
                        Button { attachments.removeAll { $0.id == a.id } } label: { Image(systemName: "xmark") }
                            .buttonStyle(.plain).foregroundStyle(Theme.ink3)
                            .help("Remove")
                    }
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Theme.bg2, in: Capsule())
                    .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                    .help(chipHelp(a))
                }
            }
        }
    }

    private func chipHelp(_ a: Attachment) -> String {
        switch a.status {
        case .uploading: "Uploading"
        case .ready(let p): p
        case .failed(let m): m
        }
    }

    private func noticeView(_ n: Notice) -> some View {
        let (fg, bg): (Color, Color) = switch n.kind {
        case .info: (Theme.ink2, Theme.bg2)
        case .warning: (Theme.amber, Theme.wash(Theme.amber))
        case .error: (Theme.brick, Theme.wash(Theme.brick))
        }
        return HStack(spacing: 8) {
            Text(n.text).font(.callout).foregroundStyle(fg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            if n.offersForce {
                Button("Send anyway") { send(force: true) }.controlSize(.small)
            }
            Button { notice = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain).foregroundStyle(fg).help("Dismiss")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(bg, in: RoundedRectangle(cornerRadius: 6))
    }

    // MARK: actions

    private func press(_ key: PaneKey) {
        model.press(key, in: session)
    }

    private func answer(_ key: String) {
        let s = session
        Task { await model.answer(s, key: key) }
    }

    private func send(force: Bool = false) {
        guard canSend else { return }
        if target == .session && session.windowOnly {
            notice = Notice(kind: .error, text: "This agent has no session inbox. Send to its pane instead.")
            if hasPane { target = .pane }
            return
        }
        if target == .pane && session.tmuxTarget == nil {
            // Never fall through to sessions.message: the user asked for the pane.
            notice = Notice(kind: .error, text: "This session has no tmux pane")
            target = .session
            return
        }
        let submittedRevision = editRevision
        let submittedIDs = Set(attachments.filter { $0.readyPath != nil }.map(\.id))
        let body = ComposerLogic.compose(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            attachmentPaths: readyPaths, host: session.host)
        let service = model.service
        let session = session
        let toPane = target == .pane
        sending = true
        notice = nil
        Task {
            defer { sending = false; model.scheduleRefresh() }
            do {
                if toPane, let pane = session.tmuxTarget {
                    let r = try await service.sendToPane(target: pane, host: session.host, text: body, enter: true, force: force)
                    if r.refused {
                        notice = Notice(kind: .warning, text: "A dialog is on screen. Answer it with its buttons, or send anyway.", offersForce: true)
                        return
                    }
                    sent(submittedRevision, submittedIDs)
                } else {
                    let r = try await service.sendMessage(to: session, text: body)
                    sent(submittedRevision, submittedIDs)
                    if r.queuedBehindTurn { notice = Notice(kind: .info, text: "Queued behind the current turn") }
                    if let reply = r.reply, !reply.isEmpty { notice = Notice(kind: .info, text: reply) }
                }
            } catch {
                notice = Notice(kind: .error, text: error.localizedDescription)
            }
        }
    }

    /// Clear only what was sent: the user may have typed the next message or added files meanwhile.
    private func sent(_ submittedRevision: Int, _ submittedIDs: Set<UUID>) {
        if editRevision == submittedRevision {
            text = ""
            model.composerDraft.removeValue(forKey: session.key)
        }
        attachments.removeAll { submittedIDs.contains($0.id) }
    }

    private func addFiles(_ urls: [URL]) {
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            if size > ComposerLogic.maxUploadBytes {
                notice = Notice(kind: .error, text: "\(name) is larger than 20 MB")
                continue
            }
            let data: Data
            do { data = try Data(contentsOf: url) } catch {
                notice = Notice(kind: .error, text: "Could not read \(name): \(error.localizedDescription)")
                continue
            }
            if data.count > ComposerLogic.maxUploadBytes {
                notice = Notice(kind: .error, text: "\(name) is larger than 20 MB")
                continue
            }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            let item = Attachment(name: name, status: .uploading)
            attachments.append(item)
            let service = model.service, session = session
            Task {
                let status: Attachment.Status
                do { status = .ready(try await service.upload(for: session, fileName: name, mime: mime, data: data)) }
                catch { status = .failed(error.localizedDescription) }
                if let i = attachments.firstIndex(where: { $0.id == item.id }) { attachments[i].status = status }
            }
        }
    }
}
