import SwiftUI

struct WaitingListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.path) {
            content
                .navigationTitle("Waiting")
                .navigationDestination(for: WaitingItem.self) { SessionDetailView(item: $0) }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        NavigationLink { PairingStatusView() } label: { Image(systemName: "iphone") }
                            .accessibilityLabel("Pairing")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if model.phase == .loading {
                            ProgressView()
                        } else {
                            Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                                .accessibilityLabel("Refresh")
                        }
                    }
                }
        }
    }

    private var failureMessage: String? {
        if case .failed(let msg) = model.phase { return msg }
        return nil
    }

    @ViewBuilder private var content: some View {
        if !model.isConfigured {
            VStack(spacing: 8) {
                Image(systemName: "applewatch.and.arrow.forward").font(.title2).foregroundStyle(Palette.ink2)
                Text("Open Drover on your iPhone to pair").multilineTextAlignment(.center).foregroundStyle(Palette.ink2)
                if let msg = failureMessage { Text(msg).font(.footnote).foregroundStyle(Palette.brick) }
            }
        } else if let summary = model.summary {
            if summary.waiting.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "checkmark.circle").font(.title2).foregroundStyle(Palette.moss)
                    Text("Nothing waiting on you").foregroundStyle(Palette.ink)
                    Text(ListFormatting.totalsLine(summary)).font(.footnote).foregroundStyle(Palette.ink3)
                }
            } else {
                List {
                    Section("Waiting on you (\(summary.waiting.count))") {
                        ForEach(summary.waiting, id: \.key) { item in
                            NavigationLink(value: item) { WaitingRow(item: item) }
                        }
                    }
                    Section {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ListFormatting.totalsLine(summary))
                            TimelineView(.periodic(from: .now, by: 60)) { context in
                                if let at = model.lastUpdated ?? summary.generatedAt?.date {
                                    let age = ListFormatting.relative(at, now: context.date)
                                    Text(age == "now" ? "Updated now" : "Updated \(age) ago")
                                }
                            }
                            if let msg = failureMessage { Text(msg).foregroundStyle(Palette.brick) }
                        }
                        .font(.footnote).foregroundStyle(Palette.ink3)
                    }
                }
            }
        } else if let msg = failureMessage {
            VStack(spacing: 8) {
                Text(msg).foregroundStyle(Palette.brick).multilineTextAlignment(.center)
                Button("Retry") { Task { await model.refresh() } }
            }
        } else {
            ProgressView()
        }
    }
}

#Preview("List") { WaitingListView().environment(AppModel.preview()) }
#Preview("Empty") { WaitingListView().environment(AppModel.preview(summary: NativeSummary())) }
