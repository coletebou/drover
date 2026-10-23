import Foundation

/// Per-category on/off and sound, plus quiet hours. Every field decodes with a default so old JSON still loads.
struct NotificationRules: Codable, Equatable, Sendable {
    struct CategoryRule: Codable, Equatable, Sendable {
        var enabled: Bool
        var sound: String?
    }

    struct QuietHours: Codable, Equatable, Sendable {
        var enabled = false
        var startMinutes = 22 * 60
        var endMinutes = 8 * 60
        var needsYouBreaksThrough = true

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
            startMinutes = try c.decodeIfPresent(Int.self, forKey: .startMinutes) ?? 22 * 60
            endMinutes = try c.decodeIfPresent(Int.self, forKey: .endMinutes) ?? 8 * 60
            needsYouBreaksThrough = try c.decodeIfPresent(Bool.self, forKey: .needsYouBreaksThrough) ?? true
        }
    }

    static let systemSounds = ["Default", "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"]

    static let defaultCategories: [String: CategoryRule] = [
        NotifyCategory.needsYou.rawValue: .init(enabled: true, sound: "Glass"),
        NotifyCategory.finished.rawValue: .init(enabled: true, sound: "Pop"),
        NotifyCategory.error.rawValue: .init(enabled: true, sound: "Basso"),
        NotifyCategory.manager.rawValue: .init(enabled: true, sound: nil),
        NotifyCategory.held.rawValue: .init(enabled: true, sound: nil),
        NotifyCategory.mr.rawValue: .init(enabled: false, sound: nil),
        NotifyCategory.launch.rawValue: .init(enabled: false, sound: nil),
        NotifyCategory.other.rawValue: .init(enabled: false, sound: nil),
    ]

    var enabled = true
    var categories: [String: CategoryRule] = NotificationRules.defaultCategories
    var quietHours = QuietHours()

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        categories = try c.decodeIfPresent([String: CategoryRule].self, forKey: .categories) ?? NotificationRules.defaultCategories
        quietHours = try c.decodeIfPresent(QuietHours.self, forKey: .quietHours) ?? QuietHours()
    }

    func rule(for category: NotifyCategory) -> CategoryRule {
        categories[category.rawValue]
            ?? NotificationRules.defaultCategories[category.rawValue]
            ?? CategoryRule(enabled: false, sound: nil)
    }

    mutating func setRule(_ rule: CategoryRule, for category: NotifyCategory) {
        categories[category.rawValue] = rule
    }

    /// True when `date` falls inside the quiet window (may wrap midnight). start == end means never quiet.
    func isQuiet(at date: Date, calendar: Calendar = .current) -> Bool {
        guard quietHours.enabled else { return false }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let now = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        let s = quietHours.startMinutes, e = quietHours.endMinutes
        if s == e { return false }
        return s < e ? (now >= s && now < e) : (now >= s || now < e)
    }

    /// Whether `item` should produce a banner at `now`.
    func shouldNotify(_ item: NotifyItem, at now: Date, calendar: Calendar = .current) -> Bool {
        guard enabled else { return false }
        if item.test { return true }
        guard rule(for: item.category).enabled else { return false }
        if isQuiet(at: now, calendar: calendar) {
            return item.category == .needsYou && quietHours.needsYouBreaksThrough
        }
        return true
    }

    /// Sound name for a category (nil = silent).
    func soundName(for category: NotifyCategory) -> String? { rule(for: category).sound }

    /// Like `soundName(for:)` but silent during quiet hours.
    func soundName(for category: NotifyCategory, at date: Date, calendar: Calendar = .current) -> String? {
        isQuiet(at: date, calendar: calendar) ? nil : soundName(for: category)
    }
}
