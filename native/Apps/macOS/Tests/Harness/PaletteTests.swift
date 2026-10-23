import AppKit
import Foundation

// Owned by the Palette slice: add suites to run().
@MainActor
enum PaletteTests {
    static func run() async {
        await T.suite("FuzzyMatch") {
            T.check(FuzzyMatch.score("xyz", in: "demo-docs") == nil, "non-subsequence")
            T.check(FuzzyMatch.score("sd", in: "demo-docs") == nil, "order matters")
            T.eq(FuzzyMatch.score("", in: "anything"), 0, "empty query")
            let prefix = FuzzyMatch.score("do", in: "docs") ?? -99
            let middle = FuzzyMatch.score("do", in: "xxdocs") ?? -99
            T.check(prefix > middle, "prefix beats middle")
            let wordStart = FuzzyMatch.score("d", in: "demo-docs-x") ?? -99
            let inside = FuzzyMatch.score("d", in: "abcdefgh") ?? -99
            T.check(wordStart > inside, "word start beats inside word")
            let camel = FuzzyMatch.score("bv", in: "boardView") ?? -99
            let flat = FuzzyMatch.score("bv", in: "boardxview".replacingOccurrences(of: "x", with: "xx")) ?? -99
            T.check(camel > flat, "camelCase boundary scores")
            T.check(FuzzyMatch.score("CAFE", in: "café") != nil, "case and diacritics")
            T.eq(FuzzyMatch.matchedIndices("dd", in: "demo-docs"), [0, 5], "indices prefer word starts")
            T.eq(FuzzyMatch.matchedIndices("docs", in: "xy-docs"), [3, 4, 5, 6])
            T.eq(FuzzyMatch.matchedIndices("zz", in: "demo"), [], "no match -> empty")
        }
        await T.suite("KeyRouter") {
            func a(_ c: String?, _ code: UInt16 = 0, _ m: NSEvent.ModifierFlags = [], text: Bool = false, palette: Bool = false) -> NavAction? {
                KeyRouter.action(characters: c, keyCode: code, modifiers: m, textInputFocused: text, paletteOpen: palette)
            }
            T.eq(a("j"), .next); T.eq(a("k"), .previous); T.eq(a("r"), .reply)
            T.eq(a("\r", 36), .open); T.eq(a("\u{3}", 76), .open, "keypad enter")
            T.eq(a("j", 0, .command), nil, "cmd"); T.eq(a("j", 0, .option), nil, "option"); T.eq(a("j", 0, .control), nil, "control")
            T.eq(a("j", 0, .shift), .next, "shift is fine")
            T.eq(a("j", text: true), nil, "text focused")
            T.eq(a("j", palette: true), nil, "palette open")
            T.eq(a("\u{F701}", 125), nil, "down arrow"); T.eq(a("\u{F700}", 126), nil, "up arrow")
            T.eq(a("x"), nil); T.eq(a(nil), nil)
        }
        await T.suite("PaletteCatalog") {
            let model = AppModel(settings: AppSettings(defaults: UserDefaults(suiteName: "harness-\(UUID())")!, group: nil),
                                 tokens: MemoryTokenStore("x"), service: MockDroverService())
            await model.refresh()
            let empty = PaletteCatalog.search("", in: PaletteCatalog.items(for: model))
            T.eq(Array(empty.prefix(2).map(\.title)), ["demo-build", "demo-review"], "waiting first")
            T.eq(empty.prefix(MockDroverService.sessions.count).filter { $0.kind == .session }.count, MockDroverService.sessions.count)
            T.check(!empty.contains { $0.kind == .tab || $0.kind == .key }, "no tab/key items without selection")
            T.check(empty.contains { $0.title == "Refresh board" }, "refresh action")
            T.check(empty.contains { $0.title == "Show host spare" }, "host views")
            T.check(empty.count <= 50)

            let docs = PaletteCatalog.search("docs", in: PaletteCatalog.items(for: model))
            T.eq(docs.first?.id, "session:studio|33333333-demo-docs", "docs query")

            model.select(model.board.sessions.first { $0.name == "demo-lint" })
            let noPane = PaletteCatalog.items(for: model)
            T.check(noPane.contains { $0.title == "Open chat" }, "tabs with selection")
            T.check(!noPane.contains { $0.kind == .key }, "no keys without tmux target")

            // A session with a dialog: its own keys, answered with the screen hash (no pane keys).
            model.select(model.board.sessions.first { $0.name == "demo-build" })
            let items = PaletteCatalog.items(for: model)
            T.check(items.contains { $0.title == "Answer demo-build: 1. Yes" }, "option item")
            T.check(items.contains { $0.title == "Answer demo-build: Esc" })
            T.check(!items.contains { $0.title.hasPrefix("Press ") }, "no raw pane keys on a dialog")
            T.check(items.contains { $0.title == "Reply to demo-build" })
            // A session without one: the pane keys.
            model.select(model.board.sessions.first { $0.name == "demo-docs" })
            let pane = PaletteCatalog.items(for: model)
            T.check(pane.contains { $0.title == "Press Enter in demo-docs" }, "key item")
            T.check(pane.contains { $0.title == "Press Ctrl-C in demo-docs" })
            T.eq(PaletteCatalog.search("press esc", in: pane).first?.title, "Press Esc in demo-docs")

            model.select(nil); model.sidebarSelection = .lane(.idle); model.detailTab = .info
            let item = PaletteCatalog.items(for: model).first { $0.title == "demo-docs" }
            if let item { item.perform(model) } else { T.fail("demo-docs item missing") }
            T.eq(model.selectedSession?.name, "demo-docs"); T.eq(model.detailTab, .chat); T.eq(model.sidebarSelection, .all, "filter cleared")
        }
    }
}
