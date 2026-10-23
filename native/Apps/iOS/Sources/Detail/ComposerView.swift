import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// An image ready to upload: already scaled and JPEG encoded.
struct ComposerAttachment: Identifiable {
    let id = UUID()
    let name: String
    let jpeg: Data
    let thumbnail: UIImage?
}

enum ComposerTarget: String, CaseIterable, Identifiable {
    case session = "Session", pane = "Pane"
    var id: String { rawValue }
}

struct ComposerView: View {
    let ref: SessionRef
    let tmux: String?
    let chat: ChatStore
    let screen: ScreenStore

    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .body) private var minSize: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var thumb: CGFloat = 56

    @State private var text = ""
    /// Bumped synchronously on every edit (typing and dictation), so a send clears only a draft nobody
    /// touched while it was in flight.
    @State private var textRevision = 0

    private var editableText: Binding<String> {
        Binding(get: { text }, set: { text = $0; textRevision &+= 1 })
    }
    @State private var attachments: [ComposerAttachment] = []
    @State private var target: ComposerTarget = .session
    @State private var error: String?
    @State private var dictation = DictationController()
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false

    private static let maxAttachments = 4

    private var canWrite: Bool { model.hasMainToken }
    private var canSend: Bool { canWrite && !chat.sendInFlight && ComposerText.canSend(text: text, attachmentCount: attachments.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if tmux != nil {
                Picker("Send to", selection: $target) {
                    ForEach(ComposerTarget.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Send to")
            }
            if !attachments.isEmpty { chips }
            if let message = error ?? dictation.errorMessage {
                Text(message).font(.footnote).foregroundStyle(Theme.error)
            }
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading)) : AnyLayout(HStackLayout(alignment: .bottom))
            layout {
                TextField(target == .pane ? "Type into the pane" : "Reply to the session", text: editableText, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .padding(10)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .disabled(!canWrite)
                // Three scaled 44 pt targets can exceed the width at the largest sizes, so stack them then.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 4) { attachMenu; micButton; sendButton }
                    VStack(alignment: .leading, spacing: 4) { attachMenu; micButton; sendButton }
                }
            }
            if !canWrite {
                Text("Read-only token: add the main token in Settings to reply.")
                    .font(.footnote).foregroundStyle(Theme.textSecondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Theme.surface)
        .overlay(alignment: .top) { Divider() }
        .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: Self.maxAttachments, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await addPhotos(items) }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await addFiles(urls) } }
        }
        .onDisappear { dictation.stop() }
        .onChange(of: dictation.errorMessage) { _, message in
            if let message { A11y.announce(message) }
        }
    }

    // MARK: pieces

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { a in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let img = a.thumbnail {
                                Image(uiImage: img).resizable().scaledToFill()
                            } else {
                                Image(systemName: "photo").foregroundStyle(Theme.textSecondary)
                            }
                        }
                        .frame(width: thumb, height: thumb)
                        .background(Theme.surfaceRaised)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .accessibilityLabel("Attached image \(a.name)")
                        Button {
                            attachments.removeAll { $0.id == a.id }
                            A11y.announce("Attachment removed")
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(Theme.textPrimary, Theme.surface)
                                .frame(minWidth: minSize, minHeight: minSize)
                        }
                        .offset(x: 14, y: -14)
                        .accessibilityLabel("Remove \(a.name)")
                    }
                    .padding(.trailing, 6)
                }
            }
            .padding(.top, 8)
        }
    }

    private var attachMenu: some View {
        Menu {
            Button("Photo library", systemImage: "photo.on.rectangle") { showPhotos = true }
            Button("Paste image", systemImage: "doc.on.clipboard") { Task { await addPasteboard() } }
                .disabled(!UIPasteboard.general.hasImages)
            Button("Files", systemImage: "folder") { showFiles = true }
        } label: {
            Image(systemName: "paperclip")
                .frame(minWidth: minSize, minHeight: minSize)
        }
        .disabled(!canWrite || attachments.count >= Self.maxAttachments)
        .accessibilityLabel("Attach image")
        .accessibilityHint("Choose a photo, a clipboard image or a file")
    }

    private var micButton: some View {
        Button {
            Haptics.tap()
            dictation.toggle(base: text) { text = $0; textRevision &+= 1 }
        } label: {
            Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                .foregroundStyle(dictation.isListening ? Theme.error : Theme.textPrimary)
                .frame(minWidth: minSize, minHeight: minSize)
        }
        .disabled(!canWrite || !dictation.isAvailable)
        .accessibilityLabel("Dictate")
        .accessibilityValue(dictation.isListening ? "Listening" : "")
        .accessibilityHint(dictation.isAvailable
            ? (dictation.isListening ? "Stops dictation" : "Speak to fill in the message")
            : "On-device dictation is not available for this language")
    }

    private var sendButton: some View {
        Button {
            Task { await send() }
        } label: {
            Image(systemName: "paperplane.fill")
                .frame(minWidth: minSize, minHeight: minSize)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.textPrimary)
        .disabled(!canSend)
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel("Send")
        .accessibilityValue(chat.sendInFlight ? "Sending" : "")
        .accessibilityHint(target == .pane ? "Types the message into the terminal pane" : "Sends the message to the session")
    }

    // MARK: attachments

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        defer { photoItems = [] }
        for item in items {
            guard attachments.count < Self.maxAttachments else { break }
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                error = "That photo could not be loaded."
                continue
            }
            await add(data: data)
        }
    }

    private func addFiles(_ urls: [URL]) async {
        for url in urls {
            guard attachments.count < Self.maxAttachments else { break }
            let data = await Task.detached { () -> Data? in
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                return try? Data(contentsOf: url)
            }.value
            guard let data else { error = "That file could not be read."; continue }
            await add(data: data)
        }
    }

    private func addPasteboard() async {
        guard let image = UIPasteboard.general.image, let data = image.jpegData(compressionQuality: 1) else {
            error = "There is no image on the clipboard."
            return
        }
        await add(data: data)
    }

    private func add(data: Data) async {
        if ComposerText.isTooLarge(data.count) { error = "That image is larger than 20 MB."; return }
        let processed = await Task.detached { Self.prepare(data) }.value
        guard let processed else { error = "That file is not an image I can read."; return }
        if ComposerText.isTooLarge(processed.count) { error = "That image is larger than 20 MB."; return }
        let thumbnail = UIImage(data: processed)?.preparingThumbnail(of: CGSize(width: 160, height: 160))
        attachments.append(ComposerAttachment(name: "image-\(attachments.count + 1).jpg", jpeg: processed, thumbnail: thumbnail))
        error = nil
    }

    /// Scales so the longest side is at most 2048 px and encodes JPEG at quality 0.8.
    private nonisolated static func prepare(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let size = image.size
        let (w, h) = ComposerText.fitSize(Double(size.width), Double(size.height), maxSide: ComposerText.maxSide)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: format)
        return renderer.jpegData(withCompressionQuality: 0.8) { _ in
            image.draw(in: CGRect(x: 0, y: 0, width: w, height: h))
        }
    }

    // MARK: send

    private func send() async {
        guard canSend else { return }
        dictation.stop()
        error = nil
        chat.sendInFlight = true
        defer { chat.sendInFlight = false }

        // Snapshot every input before the first suspension: edits made while this send runs belong to the
        // next message and are kept.
        let api = model.api
        let sentAttachments = attachments
        let sentText = text
        let sentRevision = textRevision
        let sentTarget = target
        let sentPane = tmux
        var outcome = "Message sent"
        do {
            var paths: [String] = []
            for a in sentAttachments {
                let r = try await api.upload(ref, name: a.name, mime: "image/jpeg", data: a.jpeg)
                paths.append(r.path)
            }
            let message = ComposerText.build(text: sentText, paths: paths)

            switch (sentTarget, sentPane) {
            case (.pane, let pane?):
                let r = try await api.sendToPane(host: ref.hostArg, target: pane, text: message, enter: true)
                if r.refused == true {
                    error = "A dialog is on screen. Answer it with the keys first."
                    Haptics.warning()
                    A11y.announce("Message not sent. A dialog is on screen.")
                    return
                }
                if r.ok == false { throw DroverError.server(r.error ?? r.reason ?? "The pane did not accept the text.") }
                _ = chat.addPending(message, status: .sent)
                outcome = "Message sent to the pane"
                await screen.refresh(host: ref.hostArg, target: pane, api: api)
            default:
                let id = chat.addPending(message, status: .sending)
                do {
                    let r = try await api.message(ref, text: message)
                    if r.ok == false { throw DroverError.server(r.error ?? "The session did not accept the message.") }
                    chat.setPending(id, status: r.queuedBehindTurn == true ? .queued : .sent)
                    outcome = r.queuedBehindTurn == true ? "Message queued" : "Message sent"
                } catch {
                    chat.removePending(id)
                    throw error
                }
            }
            Haptics.success()
            A11y.announce(outcome)
            if textRevision == sentRevision { text = "" }
            let sentIDs = Set(sentAttachments.map(\.id))
            attachments.removeAll { sentIDs.contains($0.id) }
        } catch {
            self.error = error.localizedDescription
            Haptics.failure()
            A11y.announce("Message failed. \(error.localizedDescription)")
        }
    }
}
