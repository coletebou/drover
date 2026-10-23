import SwiftUI

/// Three columns like the web board: sidebar (manager, views, hosts), board (lanes), detail (Chat, Screen, Info, or the
/// manager).
struct ContentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 290)
        } content: {
            BoardView()
                .navigationSplitViewColumnWidth(min: 300, ideal: 380, max: 520)
        } detail: {
            DetailView()
                .navigationSplitViewColumnWidth(min: 440, ideal: 700)
        }
        .modifier(KeyboardNavigation())
        .sheet(isPresented: $model.isPaletteOpen) {
            CommandPalette()
                .environment(model)
        }
        .sheet(isPresented: Binding(get: { model.pairLink != nil }, set: { if !$0 { model.dismissPairLink() } })) {
            if let url = model.pairLink {
                PairLinkSheet(url: url)
                    .environment(model)
            }
        }
        .overlay(alignment: .bottom) { ToastView() }
        .background(Theme.bg)
        .background(WindowReader { window in
            WindowRouter.shared.mainWindowAppeared(open: openWindow, window: window)
        })
        .onAppear { WindowRouter.shared.mainWindowAppeared(open: openWindow, window: nil) }
        .onDisappear { WindowRouter.shared.mainWindowClosed() }
    }
}

/// `model.toast`, for a few seconds.
struct ToastView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let t = model.toast {
            Text(t.text)
                .font(.callout)
                .foregroundStyle(t.kind == .error ? Theme.brick : Theme.ink)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Theme.bg3, in: Capsule())
                .overlay(Capsule().stroke(Theme.line2, lineWidth: 1))
                .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
                .padding(.bottom, 18)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .id(t.id)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}
