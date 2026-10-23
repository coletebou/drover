import UIKit

/// Haptic feedback, respecting the in-app toggle. Call from the main actor (UIKit generators).
@MainActor
enum Haptics {
    static func success() { notify(.success) }
    static func warning() { notify(.warning) }
    static func failure() { notify(.error) }

    static func tap() {
        guard SharedSettings().hapticsEnabled else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func selection() {
        guard SharedSettings().hapticsEnabled else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    private static func notify(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        guard SharedSettings().hapticsEnabled else { return }
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }
}
