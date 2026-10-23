import Foundation

// Owned by the Settings slice: add suites to run().
@MainActor
enum SettingsTests {
    private static var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return c
    }()

    private static func at(_ h: Int, _ m: Int = 0) -> Date {
        cal.date(from: DateComponents(timeZone: cal.timeZone, year: 2026, month: 10, day: 11, hour: h, minute: m)) ?? Date()
    }

    private static func item(_ cat: NotifyCategory, session: String? = nil, host: String? = nil, target: String? = nil, test: Bool = false) -> NotifyItem {
        NotifyItem(id: "i-\(cat.rawValue)", at: Date(), category: cat, kind: "k", title: "T", body: "B",
                   sessionId: session, host: host, tmuxTarget: target, test: test)
    }

    static func run() async {
        await T.suite("NotificationRules decoding") {
            let defaults = NotificationRules()
            for json in [#"{"enabled":true}"#, "{}"] {
                let r = try JSONDecoder().decode(NotificationRules.self, from: Data(json.utf8))
                T.eq(r, defaults, "defaults for \(json)")
            }
            let off = try JSONDecoder().decode(NotificationRules.self, from: Data(#"{"enabled":false}"#.utf8))
            T.eq(off.enabled, false)
            T.eq(defaults.rule(for: .needsYou).sound, "Glass")
            T.eq(defaults.rule(for: .finished).sound, "Pop")
            T.eq(defaults.rule(for: .error).sound, "Basso")
            T.eq(defaults.rule(for: .mr).enabled, false)
            var r = NotificationRules()
            r.setRule(.init(enabled: false, sound: "Tink"), for: .launch)
            r.quietHours.enabled = true
            r.quietHours.startMinutes = 60
            let back = try JSONDecoder().decode(NotificationRules.self, from: JSONEncoder().encode(r))
            T.eq(back, r, "round trip")
            var partial = NotificationRules()
            partial.categories = [:]
            T.eq(partial.rule(for: .error).sound, "Basso", "missing key falls back to default")
        }
        await T.suite("Quiet hours") {
            var r = NotificationRules()
            r.quietHours.enabled = true
            T.check(r.isQuiet(at: at(23, 30), calendar: cal), "23:30 quiet")
            T.check(r.isQuiet(at: at(2), calendar: cal), "02:00 quiet")
            T.check(!r.isQuiet(at: at(12), calendar: cal), "12:00 not quiet")
            T.check(!r.isQuiet(at: at(8), calendar: cal), "end is exclusive")
            r.quietHours.startMinutes = 9 * 60
            r.quietHours.endMinutes = 17 * 60
            T.check(r.isQuiet(at: at(12), calendar: cal), "12:00 quiet in 9-17")
            T.check(!r.isQuiet(at: at(20), calendar: cal), "20:00 not quiet in 9-17")
            r.quietHours.endMinutes = 9 * 60
            T.check(!r.isQuiet(at: at(12), calendar: cal), "start == end never quiet")
            r.quietHours.enabled = false
            r.quietHours.startMinutes = 22 * 60; r.quietHours.endMinutes = 8 * 60
            T.check(!r.isQuiet(at: at(23), calendar: cal), "disabled")
        }
        await T.suite("shouldNotify") {
            var r = NotificationRules()
            T.check(r.shouldNotify(item(.needsYou), at: at(12), calendar: cal))
            T.check(!r.shouldNotify(item(.mr), at: at(12), calendar: cal), "mr off by default")
            r.setRule(.init(enabled: false, sound: nil), for: .finished)
            T.check(!r.shouldNotify(item(.finished), at: at(12), calendar: cal), "disabled category")
            r.quietHours.enabled = true
            T.check(r.shouldNotify(item(.needsYou), at: at(23), calendar: cal), "breaks through")
            T.check(!r.shouldNotify(item(.error), at: at(23), calendar: cal), "error quiet")
            r.quietHours.needsYouBreaksThrough = false
            T.check(!r.shouldNotify(item(.needsYou), at: at(23), calendar: cal), "no breakthrough")
            T.check(r.shouldNotify(item(.mr, test: true), at: at(23), calendar: cal), "test item always")
            r.enabled = false
            T.check(!r.shouldNotify(item(.needsYou, test: true), at: at(12), calendar: cal), "master off")
        }
        await T.suite("soundName") {
            var r = NotificationRules()
            T.eq(r.soundName(for: .needsYou), "Glass")
            T.eq(r.soundName(for: .manager), nil)
            r.quietHours.enabled = true
            T.eq(r.soundName(for: .needsYou, at: at(23), calendar: cal), nil, "silent in quiet hours")
            T.eq(r.soundName(for: .needsYou, at: at(12), calendar: cal), "Glass")
        }
        await T.suite("NotificationContentBuilder") {
            let a = NotificationContentBuilder.content(for: item(.needsYou, session: "s1", host: "studio", target: "work:1"))
            T.eq(a.categoryId, "drover.session")
            T.eq(a.threadId, "s1")
            T.eq(a.userInfo, ["sessionId": "s1", "host": "studio", "category": "needs-you", "target": "work:1"])
            let b = NotificationContentBuilder.content(for: item(.mr))
            T.eq(b.categoryId, "drover.info")
            T.eq(b.threadId, "mr")
            T.eq(b.userInfo, ["category": "mr"])
            T.eq(b.title, "T"); T.eq(b.body, "B")
        }
    }
}
