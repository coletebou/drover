import SwiftUI

/// One session on the board. A dialog waiting on you shows its answer buttons right here.
struct SessionRow: View {
    let session: SessionItem
    let isSelected: Bool
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    private var laneColor: Color { Theme.color(for: session.lane) }
    private var dotColor: Color { session.isManager ? Theme.lilac : laneColor }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StateDot(color: dotColor).padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.name).font(.body).foregroundStyle(Theme.ink).lineLimit(1)
                Text(BoardFormat.subtitle(session)).font(Theme.mono).foregroundStyle(Theme.ink3).lineLimit(1)
                Text(BoardFormat.summaryLine(session))
                    .font(.caption).foregroundStyle(Theme.ink2).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if session.lane == .waiting && model.showsAnswerCard(session) {
                    DialogAnswerView(session: session, style: .inline)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 4)
            Text(BoardFormat.relative(session.updatedAt))
                .font(.caption).foregroundStyle(Theme.ink4).lineLimit(1)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? Theme.wash(laneColor) : (hovering ? Theme.bg3 : Color.clear)))
        .overlay {
            if isSelected { RoundedRectangle(cornerRadius: 6).stroke(laneColor, lineWidth: 1) }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(session.name), \(session.lane.title), \(session.headline ?? session.status)")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
