#if os(iOS) || os(watchOS)
import SwiftUI
import WidgetKit

private let emptyEntry = SummaryEntry(date: .now, summary: SummaryFixtures.empty, hostFilter: nil, status: .live)
private let setupEntry = SummaryEntry(date: .now, summary: nil, hostFilter: nil, status: .notConfigured)

#Preview("Circular", as: .accessoryCircular) { DroverWaitingWidget() } timeline: {
    SummaryEntry.placeholder
    emptyEntry
    setupEntry
}

#Preview("Rectangular", as: .accessoryRectangular) { DroverWaitingWidget() } timeline: {
    SummaryEntry.placeholder
    emptyEntry
    setupEntry
}

#Preview("Inline", as: .accessoryInline) { DroverWaitingWidget() } timeline: {
    SummaryEntry.placeholder
    emptyEntry
    setupEntry
}

#if os(watchOS)
#Preview("Corner", as: .accessoryCorner) { DroverWaitingWidget() } timeline: {
    SummaryEntry.placeholder
    emptyEntry
    setupEntry
}
#endif
#endif
