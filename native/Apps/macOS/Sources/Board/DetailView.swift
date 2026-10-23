import SwiftUI

/// Detail for `model.selectedSession`: tab picker bound to `model.detailTab`;
/// Chat -> ChatView(session:), Screen -> ScreenView(session:), Info -> SessionInfoView(session:).
/// The manager (its sidebar entry, or its strip on the board) gets the full manager chat instead.
struct DetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Group {
            if model.showsManager {
                ManagerView()
            } else if let s = model.selectedSession {
                VStack(alignment: .leading, spacing: 0) {
                    header(s)
                    Picker("Detail", selection: $model.detailTab) {
                        ForEach(DetailTab.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .padding(.horizontal, 16).padding(.bottom, 10)
                    Divider().overlay(Theme.line)
                    Group {
                        switch model.detailTab {
                        case .chat: ChatView(session: s)
                        case .screen: ScreenView(session: s)
                        case .info: SessionInfoView(session: s)
                        }
                    }
                    .id(s.key)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ContentUnavailableView("Select a session", systemImage: "rectangle.stack",
                                       description: Text("Pick one on the board, or press j and k. The manager is at the top of the sidebar."))
            }
        }
        .background(Theme.bg)
    }

    private func header(_ s: SessionItem) -> some View {
        let color = Theme.color(for: s.lane)
        return HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(s.name).font(Theme.titleFont(20)).foregroundStyle(Theme.ink).lineLimit(1)
                Text(BoardFormat.subtitle(s) + " · " + BoardFormat.shortId(s.transcriptId))
                    .font(Theme.mono).foregroundStyle(Theme.ink3).lineLimit(1)
            }
            Spacer()
            Text(s.answersWithKeys && s.lane == .waiting ? (s.held ? "Held message" : "Dialog on screen") : s.lane.title)
                .font(.caption.weight(.medium))
                .foregroundStyle(color)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(Theme.wash(color)))
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 10)
        .accessibilityElement(children: .combine)
    }
}
