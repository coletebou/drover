import SwiftUI
import WidgetKit

#if !os(watchOS)
struct DroverSummaryWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: SharedConfig.summaryWidgetKind, intent: HostFilterIntent.self,
                               provider: SummaryProvider()) { entry in
            SummaryWidgetView(entry: entry)
        }
        .configurationDisplayName("Fleet summary")
        .description("Sessions waiting on you, working and idle.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
#endif

#if os(iOS) || os(watchOS)
struct DroverWaitingWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: SharedConfig.waitingWidgetKind, intent: HostFilterIntent.self,
                               provider: SummaryProvider()) { entry in
            SummaryWidgetView(entry: entry)
        }
        .configurationDisplayName("Waiting on you")
        .description("How many sessions need you, and the top one.")
        #if os(watchOS)
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
        #else
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
        #endif
    }
}
#endif
