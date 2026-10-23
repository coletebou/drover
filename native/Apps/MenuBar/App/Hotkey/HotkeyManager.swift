import Carbon.HIToolbox
import Foundation

/// Registers one system-wide hotkey through Carbon (no Accessibility permission needed).
@MainActor
final class HotkeyManager {
    private let onPress: @MainActor () -> Void
    // nonisolated(unsafe) so deinit (nonisolated) can release the refs; only touched on the main actor otherwise.
    nonisolated(unsafe) private var hotKeyRef: EventHotKeyRef?
    nonisolated(unsafe) private var handlerRef: EventHandlerRef?

    private static let hotKeyID = EventHotKeyID(signature: OSType(0x4452_564D), id: 1)  // 'DRVM'

    init(onPress: @escaping @MainActor () -> Void) {
        self.onPress = onPress
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }

    /// Replaces any previous hotkey. `nil` just unregisters. Returns false if registration fails
    /// (for example the combo is already taken by another app).
    @discardableResult
    func register(_ combo: KeyCombo?) -> Bool {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        guard let combo else { return true }
        guard installHandlerIfNeeded() else { return false }

        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            combo.keyCode, combo.carbonModifiers, Self.hotKeyID,
            GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else { return false }
        hotKeyRef = ref
        return true
    }

    private func installHandlerIfNeeded() -> Bool {
        if handlerRef != nil { return true }
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        var ref: EventHandlerRef?
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData in
                guard let event, let userData else { return OSStatus(eventNotHandledErr) }
                var id = EventHotKeyID()
                let got = GetEventParameter(
                    event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                    nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
                guard got == noErr, id.signature == HotkeyManager.hotKeyID.signature,
                      id.id == HotkeyManager.hotKeyID.id
                else { return OSStatus(eventNotHandledErr) }
                // Carbon delivers application-target events on the main thread, so assuming main
                // actor isolation here is sound.
                let manager = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
                MainActor.assumeIsolated { manager.onPress() }
                return noErr
            },
            1, &spec, Unmanaged.passUnretained(self).toOpaque(), &ref)
        guard status == noErr, let ref else { return false }
        handlerRef = ref
        return true
    }
}
