import Foundation

// Logic tests of the chat slice.
extension Suites {
    static var chatSuites: [(String, () async throws -> Void)] { [("chat", chat), ("chat headless", chatHeadless)] }

    static func chat() async throws {
        func t(_ role: String, _ id: String, _ text: String? = "x", meta: Bool? = nil) -> Turn {
            Turn(role: role, uuid: id, text: text, meta: meta)
        }
        // incremental rule
        expect(ChatMerge.since(engine: .claude, offset: 120) == 120, "claude with offset is incremental")
        expect(ChatMerge.since(engine: .claude, offset: 0) == nil, "claude without offset is full")
        expect(ChatMerge.since(engine: .codex, offset: 5) == nil, "codex always full")
        expect(ChatMerge.since(engine: .openclaw, offset: 5) == nil, "openclaw always full")
        expect(ChatMerge.since(engine: nil, offset: 5) == nil, "unknown engine full")

        // append dedupes
        let a = [t("user", "1"), t("assistant", "2")]
        let merged = ChatMerge.append(a, [t("assistant", "2"), t("user", "3")])
        expect(merged.map(\.id) == ["1", "2", "3"], "dedupe by id")

        // replace for full pages
        let page = TranscriptPage(engine: .codex, turns: [t("user", "9"), t("user", "9"), t("assistant", "10")], offset: 0)
        expect(ChatMerge.apply(page: page, to: a, usedSince: false).map(\.id) == ["9", "10"], "full replace and dedupe")
        expect(ChatMerge.apply(page: page, to: a, usedSince: true).count == 4, "incremental appends")

        // cap
        let many = (0..<600).map { t("user", "u\($0)") }
        let capped = ChatMerge.append([], many)
        expect(capped.count == 500 && capped.first?.id == "u100" && capped.last?.id == "u599", "cap keeps newest 500")

        // visibility
        expect(!ChatMerge.isVisible(t("user", "m", "hi", meta: true)), "meta user hidden")
        expect(!ChatMerge.isVisible(t("assistant", "e", "  \n")), "empty hidden")
        expect(ChatMerge.isVisible(t("thinking", "th", nil)), "thinking kept when empty")
        expect(ChatMerge.plainText([t("user", "1", "hello"), t("tool_result", "2", "out"), t("assistant", "3", "hi")])
               == "user: hello\nassistant: hi", "plain text export")

        // pending reconciliation
        let p1 = ChatPending(text: "fix  the bug", status: .sent)
        let p2 = ChatPending(text: "other", status: .queued)
        let p3 = ChatPending(text: "fix the bug", status: .sending)
        let left = ChatPending.reconcile([p1, p2, p3], with: [t("user", "a", "fix the bug")])
        expect(left.map(\.id) == [p2.id, p3.id], "sent echoed is dropped, sending kept")
        expect(p2.statusLabel.hasPrefix("Queued"), "queued label")

        // composer text
        expect(ComposerText.build(text: " hi ", paths: []) == "hi", "no attachments")
        expect(ComposerText.build(text: "hi", paths: ["/a.jpg", "/b.jpg"])
               == "hi\n\n[Attached image: /a.jpg] Read it with the Read tool.\n[Attached image: /b.jpg] Read it with the Read tool.",
               "attachment lines")
        expect(ComposerText.build(text: "", paths: ["/a.jpg"]) == "[Attached image: /a.jpg] Read it with the Read tool.",
               "attachment only")
        expect(ComposerText.canSend(text: "  ", attachmentCount: 0) == false, "blank cannot send")
        expect(ComposerText.canSend(text: "", attachmentCount: 1), "attachment can send")
        expect(ComposerText.isTooLarge(20 * 1024 * 1024 + 1) && !ComposerText.isTooLarge(20 * 1024 * 1024), "20 MB limit")
        let f = ComposerText.fitSize(4096, 2048, maxSide: 2048)
        expect(f.0 == 2048 && f.1 == 1024, "fit landscape")
        let g = ComposerText.fitSize(1000, 3000, maxSide: 2048)
        expect(g.0 == 683 && g.1 == 2048, "fit portrait")
        let s = ComposerText.fitSize(800, 600, maxSide: 2048)
        expect(s.0 == 800 && s.1 == 600, "no upscale")
        expect(ComposerText.dictated(base: "note", partial: "hello") == "note hello", "dictation appended")
        expect(ComposerText.dictated(base: "", partial: "hello") == "hello", "dictation empty base")
        expect(ComposerText.dictated(base: "note", partial: "") == "note", "dictation empty partial")
    }
}

extension Suites {
    /// Headless agents answer rolling snapshots: never read them incrementally (second review finding).
    static func chatHeadless() throws {
        expect(ChatMerge.since(engine: .claude, offset: 120, headless: true) == nil, "headless claude is full")
        let page = try decode(TranscriptPage.self, #"{"engine":"claude","headless":true,"turns":[{"role":"assistant","text":"a"}],"offset":7}"#)
        expect(page.headless == true, "headless flag decodes")
    }
}
