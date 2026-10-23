import Foundation

@MainActor
enum ChatTests {
    private static func turn(_ id: String) -> TranscriptTurn {
        TranscriptTurn(id: id, role: .assistant, text: id, ts: nil, tools: [], meta: false)
    }

    static func run() async {
        await T.suite("ChatModel.merge") {
            let a = [turn("1"), turn("2")]
            let inc = ChatModel.merge(existing: a, page: TranscriptPage(turns: [turn("2"), turn("3"), turn("4")], offset: 9), incremental: true)
            T.eq(inc.map(\.id), ["1", "2", "3", "4"], "dedupe + append order")
            let full = ChatModel.merge(existing: a, page: TranscriptPage(turns: [turn("x")], offset: nil), incremental: false)
            T.eq(full.map(\.id), ["x"], "full replace")
            let many = (0..<1200).map { turn("\($0)") }
            let capped = ChatModel.merge(existing: [], page: TranscriptPage(turns: many, offset: 1), incremental: false)
            T.eq(capped.count, 1000, "cap")
            T.eq(capped.first?.id, "200", "keeps the last 1000")
            let capInc = ChatModel.merge(existing: Array(many.prefix(1000)), page: TranscriptPage(turns: [turn("new")], offset: 1), incremental: true)
            T.eq(capInc.count, 1000); T.eq(capInc.last?.id, "new"); T.eq(capInc.first?.id, "1")
        }
        await T.suite("ComposerLogic.compose") {
            T.eq(ComposerLogic.compose(text: "hello", attachmentPaths: [], host: "studio"), "hello")
            T.eq(ComposerLogic.compose(text: " hi ", attachmentPaths: ["/a/b.png"], host: "studio"),
                 "hi\n\nAttached file on studio (read it with the Read tool):\n- /a/b.png")
            T.eq(ComposerLogic.compose(text: "hi", attachmentPaths: ["/a", "/b"], host: "studio"),
                 "hi\n\nAttached files on studio (read them with the Read tool):\n- /a\n- /b")
            T.eq(ComposerLogic.compose(text: "", attachmentPaths: ["/a"], host: "local"),
                 "Attached file on this machine (read it with the Read tool):\n- /a")
            T.eq(ComposerLogic.hostLabel(""), "this machine")
        }
        await T.suite("ChatModel.load") {
            let chat = ChatModel()
            await chat.load(service: MockDroverService(), session: MockDroverService.sessions[0])
            let n = MockDroverService.transcript().count
            T.eq(chat.turns.count, n); T.eq(chat.offset, 4096)
            await chat.poll(service: MockDroverService(), session: MockDroverService.sessions[0])
            T.eq(chat.turns.count, n, "poll adds nothing new"); T.eq(chat.offset, 4096)
            T.check(chat.error == nil)
        }
    }
}
