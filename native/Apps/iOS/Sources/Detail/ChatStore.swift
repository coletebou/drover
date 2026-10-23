import Foundation
import Observation

/// Transcript state for one session detail screen.
@MainActor
@Observable
final class ChatStore {
    private(set) var turns: [Turn] = []
    private(set) var offset = 0
    private(set) var engine: Engine?
    private(set) var headless = false
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    private(set) var error: String?
    private(set) var pending: [ChatPending] = []
    /// While true, polling is paused so a send does not race a refetch.
    var sendInFlight = false

    private var fetching = false

    var visibleTurns: [Turn] { ChatMerge.visible(turns) }

    /// First or manual load. Shows the loading indicator.
    func load(ref: SessionRef, api: any DroverAPI, engineHint: Engine?) async {
        await fetch(ref: ref, api: api, engineHint: engineHint, showSpinner: true)
    }

    /// Timer driven refresh. Skipped while a send is in flight.
    func poll(ref: SessionRef, api: any DroverAPI, engineHint: Engine?) async {
        guard !sendInFlight else { return }
        await fetch(ref: ref, api: api, engineHint: engineHint, showSpinner: false)
    }

    private func fetch(ref: SessionRef, api: any DroverAPI, engineHint: Engine?, showSpinner: Bool) async {
        guard !fetching else { return }
        fetching = true
        if showSpinner { isLoading = true }
        defer { fetching = false; isLoading = false }
        let knownEngine = engine ?? engineHint
        let since = ChatMerge.since(engine: knownEngine, offset: offset, headless: headless)
        do {
            let page = try await api.transcript(ref, since: since, limit: ChatMerge.pageLimit)
            guard !Task.isCancelled else { return }
            engine = page.engine ?? knownEngine
            headless = page.headless ?? headless
            turns = ChatMerge.apply(page: page, to: turns, usedSince: since != nil)
            offset = page.offset ?? offset
            pending = ChatPending.reconcile(pending, with: turns)
            error = nil
            hasLoaded = true
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            hasLoaded = true
        }
    }

    // MARK: pending bubbles

    func addPending(_ text: String, status: ChatPending.Status = .sending) -> UUID {
        let p = ChatPending(text: text, status: status)
        pending.append(p)
        return p.id
    }

    func setPending(_ id: UUID, status: ChatPending.Status) {
        guard let i = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[i].status = status
    }

    func removePending(_ id: UUID) {
        pending.removeAll { $0.id == id }
    }
}

/// Latest tmux capture for the session, shared by the Screen tab, the dialog key row and the composer.
@MainActor
@Observable
final class ScreenStore {
    private(set) var capture: ScreenCapture?
    private(set) var error: String?
    private(set) var keyError: String?
    private(set) var isLoading = false
    private var fetching = false

    var state: String? { capture?.screen?.state }
    var isDialog: Bool { state == "dialog" }

    func refresh(host: String?, target: String, api: any DroverAPI, lines: Int = 120) async {
        guard !fetching else { return }
        fetching = true
        defer { fetching = false; isLoading = false }
        do {
            let c = try await api.capture(host: host, target: target, lines: lines)
            guard !Task.isCancelled else { return }
            capture = c
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Sends one key, then refreshes the capture.
    func sendKey(_ key: PaneKey, host: String?, target: String, api: any DroverAPI) async {
        keyError = nil
        do {
            let r = try await api.sendKeys(host: host, target: target, keys: [key])
            if r.ok == false { keyError = r.error ?? r.reason ?? "The key was not delivered." }
        } catch {
            keyError = error.localizedDescription
        }
        await refresh(host: host, target: target, api: api)
    }
}
