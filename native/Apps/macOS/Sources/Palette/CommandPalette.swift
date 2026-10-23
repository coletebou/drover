import SwiftUI

/// Cmd+K palette, presented as a sheet by ContentView while `model.isPaletteOpen`.
struct CommandPalette: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool

    private var results: [PaletteItem] {
        PaletteCatalog.search(query, in: PaletteCatalog.items(for: model))
    }

    var body: some View {
        let results = self.results
        VStack(spacing: 0) {
            TextField("Search sessions, views and actions", text: $query)
                .textFieldStyle(.plain)
                .font(.system(size: 17))
                .foregroundStyle(Theme.ink)
                .focused($focused)
                .padding(.horizontal, 16).padding(.vertical, 14)
                .onSubmit { run(results) }
                .onKeyPress(.downArrow) { move(1, count: results.count); return .handled }
                .onKeyPress(.upArrow) { move(-1, count: results.count); return .handled }
                .onKeyPress(.escape) { close(); return .handled }
                .onChange(of: query) { _, _ in selection = 0 }
            Divider().overlay(Theme.line)
            if results.isEmpty {
                Text("No matches")
                    .foregroundStyle(Theme.ink4)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.vertical, 24)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(results.enumerated()), id: \.element.id) { i, item in
                                row(item, selected: i == selection)
                                    .id(item.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture { run(item) }
                                    .onHover { if $0 { selection = i } }
                            }
                        }
                        .padding(6)
                    }
                    .onChange(of: selection) { _, new in
                        if results.indices.contains(new) { proxy.scrollTo(results[new].id) }
                    }
                }
            }
            Divider().overlay(Theme.line)
            Text("↑↓ to move · Return to run · Esc to close")
                .font(.caption).foregroundStyle(Theme.ink4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .frame(width: 560)
        .frame(minHeight: 200, maxHeight: 420)
        .background(Theme.bg2)
        .onAppear { focused = true }
    }

    private func row(_ item: PaletteItem, selected: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: item.symbol)
                .foregroundStyle(item.tint ?? Theme.ink3)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(highlighted(item.title))
                    .lineLimit(1)
                if let sub = item.subtitle {
                    Text(sub).font(Theme.mono).foregroundStyle(Theme.ink3).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(item.kind.label).font(.caption).foregroundStyle(Theme.ink4)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.bg3 : Color.clear))
    }

    private func highlighted(_ title: String) -> AttributedString {
        let hits = Set(FuzzyMatch.matchedIndices(query, in: title))
        var out = AttributedString()
        for (i, ch) in title.enumerated() {
            var piece = AttributedString(String(ch))
            if hits.contains(i) {
                piece.font = .body.weight(.semibold)
                piece.foregroundColor = Theme.ink
            } else {
                piece.foregroundColor = hits.isEmpty ? Theme.ink : Theme.ink2
            }
            out.append(piece)
        }
        return out
    }

    private func move(_ delta: Int, count: Int) {
        guard count > 0 else { return }
        selection = max(0, min(count - 1, selection + delta))
    }

    private func close() { model.isPaletteOpen = false }

    private func run(_ results: [PaletteItem]) {
        guard results.indices.contains(selection) else { return }
        run(results[selection])
    }

    private func run(_ item: PaletteItem) {
        close()
        item.perform(model)
    }
}
