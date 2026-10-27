import SwiftUI

struct WaitingRow: View {
    let item: WaitingItem

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Image(systemName: item.approval != nil ? "checkmark.seal" : item.kind.symbol).foregroundStyle(item.kind.tint)
                    Text(item.name).font(Palette.title(.headline)).foregroundStyle(Palette.ink).lineLimit(1)
                }
                Text(item.headline).font(.footnote).foregroundStyle(Palette.ink2).lineLimit(3)
                HStack {
                    Text(item.host ?? "local").font(Palette.mono(.caption2)).foregroundStyle(Palette.ink3).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(ListFormatting.relative(item.since?.date, now: context.date))
                        .font(.caption2).foregroundStyle(Palette.ink3)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(ListFormatting.accessibilityLabel(item, now: context.date))
        }
    }
}

#Preview {
    List { WaitingRow(item: PreviewData.summary.waiting[0]) }
        .environment(AppModel.preview())
}
