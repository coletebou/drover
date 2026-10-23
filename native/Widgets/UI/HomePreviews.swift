#if !os(watchOS)
import SwiftUI
import WidgetKit

#if DEBUG
private let previewEntries: [SummaryEntry] = [
    .placeholder,
    SummaryEntry(date: .now, summary: SummaryFixtures.empty, hostFilter: "demo-mac",
                 status: .cached(fetchedAt: .now.addingTimeInterval(-600))),
    SummaryEntry(date: .now, summary: nil, hostFilter: nil, status: .unreachable),
]

#Preview("Small", as: .systemSmall) {
    DroverSummaryWidget()
} timeline: {
    previewEntries[0]
    previewEntries[1]
    previewEntries[2]
}

#Preview("Medium", as: .systemMedium) {
    DroverSummaryWidget()
} timeline: {
    previewEntries[0]
    previewEntries[1]
    previewEntries[2]
}

#Preview("Large", as: .systemLarge) {
    DroverSummaryWidget()
} timeline: {
    previewEntries[0]
    previewEntries[1]
    previewEntries[2]
}
#endif
#endif
