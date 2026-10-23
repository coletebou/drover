import AppKit

enum NotificationSounds {
    /// nil or "None": silent. "Default": system beep. Otherwise a named system sound.
    @MainActor
    static func play(_ name: String?) {
        guard let name, name != "None" else { return }
        if name == "Default" { NSSound.beep(); return }
        NSSound(named: NSSound.Name(name))?.play()
    }
}
