import Foundation
import Observation

/// The fleet manager's chat (session "manager", engine openclaw), shared by the Manager view in the main window and the
/// floating panel. Messages go out with `wait: false` and the reply streams in as `manager` events; the transcript is
/// read per thread. Requests have no 40 s idle timeout (LiveDroverService.managerTimeout), so an older daemon that holds
/// the call until the reply works too.
@Observable @MainActor
final class ManagerModel {
    static let quickPrompts: [(title: String, text: String)] = [
        ("Who is waiting on me?", "Who is waiting on me?"),
        ("What finished since I last looked?", "What finished since I last looked?"),
        ("Status of every machine", "Status of every machine"),
    ]
    /// Thread names the daemon accepts (`win-@12` names a window's own manager).
    nonisolated static let threadPattern = #"^[A-Za-z0-9_.:@%-]{1,64}$"#

    weak var app: AppModel?
    private(set) var conversation: ManagerConversation
    let rows = ChatRows()
    private(set) var threads: [ManagerThread] = []
    /// False when the daemon has no `openclaw.threads` (only `main` then).
    private(set) var threadsSupported = true
    private(set) var isLoading = false
    private(set) var loadedThread: String?
    var error: String?
    /// A short note under the composer ("Sweep queued").
    var notice: String?
    /// Text the composer starts with (a quick prompt, the panel's reply).
    var draft = ""
    /// Bumped to focus the composer.
    private(set) var focusRequest = 0
    private(set) var sweeping = false

    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = defaults.string(forKey: "drover.managerThread") ?? "main"
        conversation = ManagerConversation(thread: saved.range(of: Self.threadPattern, options: .regularExpression) != nil ? saved : "main")
    }

    var thread: String { conversation.thread }
    var items: [ChatItem] { rows.items }

    // MARK: status

    var host: String? { app?.managerHost }
    var isUp: Bool { app?.board.manager.up ?? false || app?.managerSession?.live == true }
    var isBusy: Bool { conversation.isReplying || app?.managerSession?.status == "busy" }
    var statusText: String {
        if isBusy { return "Answering" }
        return isUp ? "Up" : (app?.boardLoaded == true ? "Down" : "Unknown")
    }

    // MARK: loading

    /// What the shown conversation has to have been read for: this thread, on the host that runs the manager now. A
    /// front daemon without a manager of its own learns that host from the board, after a first read may have gone out.
    var loadKey: String { "\(thread)|\(host ?? "")" }
    /// The loadKey of the last read that landed.
    private(set) var loadedKey: String?

    /// The view's task (id: loadKey): read again when the thread or the manager's host changed since the last read.
    func refreshIfStale() async {
        if loadedKey != loadKey { await refresh() } else { await refreshThreads() }
    }

    /// Read the thread (and the thread list). Cheap; called on open, on reconnect and on thread switch.
    func refresh() async {
        guard let app else { return }
        let service = app.service, gen = app.generation
        let thread = self.thread, host = self.host, key = loadKey
        isLoading = loadedThread != thread
        defer { isLoading = false }
        do {
            let page = try await service.managerTranscript(thread: thread, host: host)
            // An answer from a host that no longer runs the manager is not this conversation's.
            guard current(thread, gen), host == self.host else { return }
            conversation.load(page)
            loadedThread = thread
            loadedKey = key
            error = nil
            relayout()
        } catch {
            if Task.isCancelled || !current(thread, gen) || host != self.host { return }
            self.error = error.localizedDescription
        }
        await refreshThreads()
    }

    func refreshThreads() async {
        guard let app, threadsSupported else { return }
        let service = app.service, gen = app.generation
        do {
            var list = try await service.managerThreads(host: host)
            guard current(gen) else { return }
            if !list.contains(where: { $0.thread == "main" }) { list.append(ManagerThread(thread: "main", turns: 0)) }
            if !list.contains(where: { $0.thread == thread }) { list.insert(ManagerThread(thread: thread, turns: 0), at: 0) }
            threads = list
        } catch DroverError.unsupported {
            guard current(gen) else { return }
            threadsSupported = false
            threads = [ManagerThread(thread: "main", turns: 0)]
        } catch {
            // Keep the last list.
        }
    }

    /// Another server (AppModel.reconfigure): nothing the last one said stays, its late answers are dropped (`current`),
    /// and threads are asked for again, since this one may have them.
    func reset() {
        conversation = ManagerConversation(thread: thread)
        threads = []
        threadsSupported = true
        loadedThread = nil
        loadedKey = nil
        error = nil
        notice = nil
        relayout()
    }

    /// An answer is still this conversation's: the server it was asked of (AppModel.generation), and the thread.
    private func current(_ gen: Int) -> Bool { gen == app?.generation }
    private func current(_ thread: String, _ gen: Int) -> Bool { thread == self.thread && current(gen) }

    /// Switch conversation (`main` is the one every client shares).
    func switchThread(_ name: String) {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard name != thread, name.range(of: Self.threadPattern, options: .regularExpression) != nil else { return }
        conversation = ManagerConversation(thread: name)
        defaults.set(name, forKey: "drover.managerThread")
        loadedThread = nil
        error = nil
        notice = nil
        relayout()
        Task { await refresh() }
    }

    static func isValidThread(_ name: String) -> Bool { name.range(of: threadPattern, options: .regularExpression) != nil }

    // MARK: sending

    func send(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let app else { return }
        let service = app.service, gen = app.generation
        let localId = conversation.echo(text)
        notice = nil
        error = nil
        relayout()
        let thread = self.thread, host = self.host
        Task {
            do {
                let r = try await service.messageManager(text: text, thread: thread, host: host)
                guard current(thread, gen) else { return }
                conversation.confirm(echo: localId, event: r.event)
                if !r.pending, let reply = r.reply {
                    // An older daemon: the reply came back inline, no stream.
                    conversation.addInlineReply(reply, inReplyTo: r.event ?? localId)
                }
            } catch {
                guard current(thread, gen) else { return }
                conversation.fail(echo: localId, error: error.localizedDescription)
            }
            relayout()
        }
    }

    func sweep() {
        guard let app, !sweeping else { return }
        let service = app.service, gen = app.generation
        sweeping = true
        notice = nil
        let host = self.host
        Task {
            defer { sweeping = false }
            let note: String
            do { note = try await service.sweep(host: host) }
            catch { note = "Sweep failed: \(error.localizedDescription)" }
            if current(gen) { notice = note }
        }
    }

    func focusComposer(draft: String? = nil) {
        if let draft { self.draft = draft }
        focusRequest &+= 1
    }

    // MARK: events

    func apply(_ e: ManagerStreamEvent) {
        guard hostMatches(e.host) else { return }
        conversation.apply(stream: e)
        relayout(delay: e.phase == .delta ? 0.05 : 0)
    }

    func apply(turn: TranscriptTurn, host: String?) {
        guard hostMatches(host) else { return }
        conversation.apply(turn: turn)
        relayout()
    }

    private func hostMatches(_ eventHost: String?) -> Bool {
        guard let eventHost, let mine = host, mine != "local" else { return true }
        return eventHost == mine || eventHost == "local"
    }

    private func relayout(delay: Double = 0) {
        rows.schedule(conversation.display, options: ChatLayout.Options(), delay: delay)
    }
}
