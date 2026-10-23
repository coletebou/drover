import AppIntents
import WidgetKit

/// Widget configuration: show every host (nil) or only one.
struct HostFilterIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Host filter"
    static let description = IntentDescription("Show every host, or only one.")

    @Parameter(title: "Host")
    var host: HostEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Show \(\.$host)")
    }

    init() {}
    init(hostName: String?) { host = hostName.map { HostEntity(id: $0) } }

    /// nil = all hosts.
    var hostName: String? { host?.id }
}

struct HostEntity: AppEntity {
    var id: String
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Host" }
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(id)") }
    static var defaultQuery: HostEntityQuery { HostEntityQuery() }
}

struct HostEntityQuery: EntityQuery, EntityStringQuery {
    /// Returns every requested id, cached or not, so a saved configuration survives a cache miss.
    func entities(for identifiers: [String]) async throws -> [HostEntity] {
        identifiers.map { HostEntity(id: $0) }
    }

    func entities(matching string: String) async throws -> [HostEntity] {
        let all = try await suggestedEntities()
        guard !string.isEmpty else { return all }
        return all.filter { $0.id.localizedCaseInsensitiveContains(string) }
    }

    func suggestedEntities() async throws -> [HostEntity] {
        (SummaryCache.appGroup.read()?.summary.hosts ?? []).map { HostEntity(id: $0.name) }
    }
}
