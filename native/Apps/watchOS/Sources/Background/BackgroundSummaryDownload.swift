import Foundation
import WatchKit

/// Background polling over a background `URLSession` (on watchOS a suspended app can only
/// network through one). The refresh task queues a GET of `native.summary` with the widget
/// token; the system runs it and relaunches the app with a URL session background task when
/// it finishes, where the delegate commits the result.
///
/// `@unchecked Sendable`: URLSession calls the delegate on its own queue; the only mutable
/// state (`_session`, `processing`) is guarded by `lock`.
final class BackgroundSummaryDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let identifier = "dev.drover.watch.summary"
    static let shared = BackgroundSummaryDownload()

    private let lock = NSLock()
    private var _session: URLSession?
    private var processing: [UUID: Task<Void, Never>] = [:]
    private var finishedEvents = 0

    private func fetcher() -> SummaryFetcher {
        SummaryFetcher(vault: KeychainTokenVault(), config: WatchConfig(), cache: .standard(), seen: SeenWaitingStore())
    }

    private var failures: RefreshFailureCounter {
        RefreshFailureCounter(defaults: UserDefaults(suiteName: DroverIdentifiers.appGroup) ?? .standard)
    }

    /// The background session, created once per process (recreating it reconnects to tasks
    /// that finished while the app was not running).
    var session: URLSession {
        lock.withLock {
            if let s = _session { return s }
            let c = URLSessionConfiguration.background(withIdentifier: Self.identifier)
            c.sessionSendsLaunchEvents = true
            c.isDiscretionary = false
            let s = URLSession(configuration: c, delegate: self, delegateQueue: nil)
            _session = s
            return s
        }
    }

    /// Queue one download for the current server and widget token. Outstanding downloads for
    /// another server or token are cancelled; one for the same request is kept. False when not
    /// paired for updates.
    @MainActor @discardableResult
    func enqueue() async -> Bool {
        let all = await session.allTasks
        // Everything below runs in one main-actor turn after the last suspension point: the
        // credential snapshot is current (the iPhone sync writes on the main actor too) and two
        // overlapping enqueues cannot cancel each other's newer request.
        let tasks = all.filter { $0.state == .running || $0.state == .suspended }
        let request = fetcher().backgroundRequest()
        var queued = false
        for t in tasks {
            if let request, Self.sameRequest(t.originalRequest, request) { queued = true } else { t.cancel() }
        }
        guard let request else { return false }
        if queued { return true }
        let task = session.downloadTask(with: request)
        task.countOfBytesClientExpectsToSend = 512
        task.countOfBytesClientExpectsToReceive = 16 * 1024
        task.resume()
        return true
    }

    static func sameRequest(_ a: URLRequest?, _ b: URLRequest) -> Bool {
        guard let a else { return false }
        return a.url == b.url && a.value(forHTTPHeaderField: "Authorization") == b.value(forHTTPHeaderField: "Authorization")
    }

    /// From `.backgroundTask(.urlSession(identifier))`: reconnect, then stay alive until the
    /// session reported `urlSessionDidFinishEvents` and every delivered result was processed.
    /// Bounded at 25 s. When the session already existed in this process (the app was running
    /// while the download finished, so events went straight to the delegate) it also stops
    /// after 5 s with nothing outstanding.
    func handleEvents() async {
        let (before, existed) = lock.withLock { (finishedEvents, _session != nil) }
        let s = session
        let begin = ContinuousClock.now
        while ContinuousClock.now - begin < .seconds(25) {
            let (finished, pending) = lock.withLock { (finishedEvents > before, !processing.isEmpty) }
            if finished && !pending { break }
            if existed, !pending, ContinuousClock.now - begin > .seconds(5), await s.allTasks.isEmpty { break }
            do { try await Task.sleep(for: .milliseconds(200)) } catch { break }
        }
        await drain()
    }

    private func drain() async {
        let tasks = lock.withLock { Array(processing.values) }
        for t in tasks { await t.value }
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The file is deleted when this method returns: read it now, commit on the main actor
        // (serialized with unpair and the iPhone sync).
        let data = (try? Data(contentsOf: location)) ?? Data()
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        let request = downloadTask.originalRequest
        let id = UUID()
        // Registered under the lock before the task can call finish(id).
        lock.withLock {
            processing[id] = Task {
                let fresh: [WaitingItem]? = await MainActor.run {
                    do {
                        let out = try self.fetcher().ingest(data: data, status: status, request: request)
                        self.failures.recordSuccess()
                        Complications.reload()
                        BackgroundIngest.didCommit(newWaiting: out.newWaiting)
                        return out.newWaiting
                    } catch WatchClientError.superseded {
                        return nil
                    } catch {
                        self.failures.recordFailure()
                        return nil
                    }
                }
                if let fresh, !fresh.isEmpty { await NewWaitingNotifier.post(fresh) }
                self.finish(id)
            }
        }
    }

    private func finish(_ id: UUID) {
        _ = lock.withLock { processing.removeValue(forKey: id) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        if (error as? URLError)?.code == .cancelled { return }
        failures.recordFailure()
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.withLock { finishedEvents += 1 }
    }
}

/// Main-actor bridge from the background download to a running foreground model.
@MainActor
enum BackgroundIngest {
    static weak var model: AppModel?

    static func didCommit(newWaiting: [WaitingItem]) {
        guard let model else { return }
        model.reloadFromCache()
        // Frontmost: the notification is suppressed (NotificationRouter.willPresent), so buzz here.
        if !newWaiting.isEmpty, WKApplication.shared().applicationState == .active {
            model.onNewWaiting?(newWaiting)
        }
    }
}
