import Foundation

/// Synthetic data for previews and tests (CONTRACT.md: invented names only).
enum PreviewData {
    /// Launch time: fixture times are relative to it, so ages read like a live fleet ("4m").
    static let now = Date()

    /// A Grok bot's approval request on the daemon's own machine, answered by its id.
    static let approvalItem = WaitingItem(
        id: "grok:demo-alpha", name: "Demo-alpha", host: "local", engine: "grok",
        since: FlexibleDate(now.addingTimeInterval(-120)), kind: .decision,
        headline: "Buy the demo plan, 1 month, $9.99 on the demo store?", answer: "approval",
        approval: ApprovalRequest(
            id: "ap_00000000demo", bot: "grok:demo-alpha", kind: "purchase",
            question: "Buy the demo plan, 1 month, $9.99 on the demo store?",
            options: [.init(n: 1, label: "Buy it"), .init(n: 2, label: "Not now")],
            details: "You asked for it this morning. Paid with the card on file.",
            createdAt: FlexibleDate(now.addingTimeInterval(-120)), expiresAt: FlexibleDate(now.addingTimeInterval(5 * 3600)),
            complete: false),
        moreApprovals: 1)

    static let summary = NativeSummary(
        generatedAt: FlexibleDate(now),
        hosts: [
            HostSummary(name: "demo-mac", up: true, waiting: 2, working: 1, idle: 3),
            HostSummary(name: "demo-box", up: true, waiting: 1, working: 1, idle: 0),
        ],
        waiting: [
            WaitingItem(id: "s-demo-build", name: "demo-build", host: "demo-mac", engine: "claude",
                        since: FlexibleDate(now.addingTimeInterval(-240)), kind: .decision,
                        headline: "Run the migration on the staging copy first, or go straight to the full set?"),
            WaitingItem(id: "s-demo-review", name: "demo-review", host: "demo-mac", engine: "codex",
                        since: FlexibleDate(now.addingTimeInterval(-900)), kind: .question,
                        headline: "Should the retry limit be 3 or 5?"),
            WaitingItem(id: "s-demo-docs", name: "demo-docs", host: "demo-box", engine: "claude",
                        since: FlexibleDate(now.addingTimeInterval(-3600)), kind: .finished,
                        headline: "Finished: README updated and tests pass."),
            approvalItem,
        ],
        working: [
            WorkingItem(id: "s-demo-lint", name: "demo-lint", host: "demo-mac", engine: "claude", headline: "Fixing lint warnings"),
            WorkingItem(id: "s-demo-sync", name: "demo-sync", host: "demo-box", engine: "codex", headline: "Syncing fixtures"),
        ],
        totals: Totals(waiting: 4, working: 2, idle: 3, hosts: 2),
        manager: ManagerStatus(up: true, lastNoteAt: FlexibleDate(now.addingTimeInterval(-600)))
    )

    static func lastReply(for item: WaitingItem) -> LastReply {
        LastReply(id: item.id, name: item.name, engine: item.engine,
                  text: "I compared both options.\n\n\(item.headline)",
                  line: item.headline, ts: item.since)
    }
}
