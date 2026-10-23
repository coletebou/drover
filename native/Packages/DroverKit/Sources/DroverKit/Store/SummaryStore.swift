import Foundation
import Observation

@MainActor @Observable
public final class SummaryStore {
    public private(set) var summary: NativeSummary?
    public private(set) var fetchedAt: Date?
    public private(set) var lastError: DroverError?
    public private(set) var isRefreshing = false

    /// Quiet period after a live event before refreshing. Internal so tests can shorten it.
    var debounce: Duration = .seconds(2)

    @ObservationIgnored private let fetch: @Sendable () async throws -> NativeSummary
    @ObservationIgnored private let cache: SummaryCache?
    @ObservationIgnored private let onSave: (@MainActor @Sendable () -> Void)?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var followTask: Task<Void, Never>?
    @ObservationIgnored private var debounceTask: Task<Void, Never>?

    public init(fetch: @escaping @Sendable () async throws -> NativeSummary, cache: SummaryCache? = nil,
                onSave: (@MainActor @Sendable () -> Void)? = nil) {
        self.fetch = fetch
        self.cache = cache
        self.onSave = onSave
        if let loaded = cache?.load() {
            summary = loaded.summary
            fetchedAt = loaded.fetchedAt
        }
    }

    deinit {
        pollTask?.cancel()
        followTask?.cancel()
        debounceTask?.cancel()
    }

    public func refresh() async {
        if isRefreshing { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let fresh = try await fetch()
            summary = fresh
            fetchedAt = Date()
            lastError = nil
            try? cache?.save(fresh)
            onSave?()
        } catch is CancellationError {
            return
        } catch let e as DroverError {
            if e != .cancelled { lastError = e }
        } catch {
            lastError = .transport(error.localizedDescription)
        }
    }

    public func startPolling(every interval: Duration) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(for: interval)
            }
        }
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    public func follow(_ stream: EventStream) {
        followTask?.cancel()
        followTask = Task { [weak self] in
            for await update in stream.updates() {
                guard let self else { return }
                switch update {
                case .event(let event):
                    switch event.kind {
                    case .mutation, .notify, .alerts, .fleet: self.scheduleRefresh()
                    default: break
                    }
                case .open:
                    await self.refresh()
                default: break
                }
            }
        }
    }

    public func stopFollowing() {
        followTask?.cancel()
        followTask = nil
        debounceTask?.cancel()
        debounceTask = nil
    }

    private func scheduleRefresh() {
        debounceTask?.cancel()
        let delay = debounce
        debounceTask = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            await self?.refresh()
        }
    }
}

