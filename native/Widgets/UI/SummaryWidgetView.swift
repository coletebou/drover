import SwiftUI
import WidgetKit

/// Routes an entry to the home-screen / desktop views or the accessory (lock screen, complication) views.
struct SummaryWidgetView: View {
    @Environment(\.widgetFamily) private var family
    var entry: SummaryEntry

    var body: some View {
        switch family {
        #if os(iOS) || os(watchOS)
        case .accessoryCircular, .accessoryRectangular, .accessoryInline:
            AccessorySummaryView(entry: entry)
        #endif
        #if os(watchOS)
        case .accessoryCorner:
            AccessorySummaryView(entry: entry)
        #endif
        default:
            #if os(watchOS)
            AccessorySummaryView(entry: entry)
            #else
            HomeSummaryView(entry: entry)
            #endif
        }
    }
}
