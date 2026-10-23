import Foundation

/// A file queued in the composer.
struct Attachment: Identifiable, Equatable, Sendable {
    enum Status: Equatable, Sendable {
        case uploading
        /// Absolute path on the session's host.
        case ready(String)
        case failed(String)
    }
    let id = UUID()
    var name: String
    var status: Status

    var readyPath: String? {
        if case .ready(let p) = status { return p }
        return nil
    }
}

enum ComposerLogic {
    static let maxUploadBytes = 20 * 1024 * 1024

    static func hostLabel(_ host: String) -> String {
        host.isEmpty || host == "local" ? "this machine" : host
    }

    /// Same wording as the web UI: the text, then a pointer to the uploaded files.
    static func compose(text: String, attachmentPaths: [String], host: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !attachmentPaths.isEmpty else { return text }
        let n = attachmentPaths.count
        var out = trimmed.isEmpty ? "" : "\(trimmed)\n\n"
        out += "Attached file\(n > 1 ? "s" : "") on \(hostLabel(host)) (read \(n > 1 ? "them" : "it") with the Read tool):\n"
        out += attachmentPaths.map { "- \($0)" }.joined(separator: "\n")
        return out
    }
}
