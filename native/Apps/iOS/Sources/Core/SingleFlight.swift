import Foundation

/// At most one run of some async work at a time, on the main actor, plus at most one queued run.
/// A caller arriving while a run is in flight joins the queued run (creating it if needed), so it sees
/// fresh results, never runs in parallel with another call, and waits for at most two runs even when
/// calls keep arriving.
@MainActor
final class SingleFlight {
    private var current: Task<Void, Never>?
    private var queued: Task<Void, Never>?

    func run(_ work: @escaping @MainActor () async -> Void) async {
        guard let running = current else {
            let t = Task { @MainActor in
                await work()
                self.advance()
            }
            current = t
            await t.value
            return
        }
        if let queued {
            await queued.value
            return
        }
        let q = Task { @MainActor in
            await running.value
            await work()
            self.advance()
        }
        queued = q
        await q.value
    }

    /// Called by the finishing run: the queued run (if any) becomes the current one.
    private func advance() {
        current = queued
        queued = nil
    }
}
