import WidgetKit

/// Fetches `native.summary` with the widget token, falls back to the App Group cache, and asks for a refresh
/// every 5 to 15 minutes depending on what is waiting.
struct SummaryProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> SummaryEntry { .placeholder }

    func snapshot(for configuration: HostFilterIntent, in context: Context) async -> SummaryEntry {
        let host = configuration.hostName
        guard !context.isPreview else {
            // Widget gallery only: synthetic fixture data.
            return SummaryEntry(date: .now, summary: SummaryFixtures.sample.filtered(host: host), hostFilter: host, status: .live)
        }
        if let cache = SummaryCache.appGroup.read() {
            return SummaryEntry(
                date: .now, summary: cache.summary.filtered(host: host), hostFilter: host,
                status: .cached(fetchedAt: cache.fetchedAt))
        }
        // A placed widget must never show fixture data as if it were live: fetch like the timeline does.
        return await timeline(for: configuration, in: context).entries.first ?? .placeholder
    }

    func timeline(for configuration: HostFilterIntent, in context: Context) async -> Timeline<SummaryEntry> {
        let host = configuration.hostName
        let cache = SummaryCache.appGroup
        var outcome: Result<FetchResult, SummaryFetchError>?
        if let creds = WidgetCredentials.load() {
            do {
                let result = try await SummaryFetcher().fetch(creds)
                let knownHosts = cache.read()?.summary.hosts.map(\.name)
                try? cache.write(result.resultJSON)
                if knownHosts != result.summary.hosts.map(\.name) {
                    // Host choices come from the cache (watch recommendations, configuration suggestions).
                    WidgetCenter.shared.invalidateConfigurationRecommendations()
                }
                outcome = .success(result)
            } catch {
                outcome = .failure(error)
            }
        }
        let now = Date.now
        let resolved = EntryResolver.resolve(fetch: outcome, cache: cache.read(), hostFilter: host)
        let entry = SummaryEntry(date: now, summary: resolved.summary, hostFilter: host, status: resolved.status)
        let next = RefreshPolicy.nextRefresh(after: now, summary: resolved.summary, status: resolved.status)
        return Timeline(entries: [entry], policy: .after(next))
    }

    #if os(watchOS)
    /// watchOS has no widget configuration UI: each recommendation becomes a selectable complication.
    func recommendations() -> [AppIntentRecommendation<HostFilterIntent>] {
        var list = [AppIntentRecommendation(intent: HostFilterIntent(), description: "All hosts")]
        for host in (SummaryCache.appGroup.read()?.summary.hosts ?? []).prefix(4) {
            list.append(AppIntentRecommendation(intent: HostFilterIntent(hostName: host.name), description: host.name))
        }
        return list
    }
    #endif
}
