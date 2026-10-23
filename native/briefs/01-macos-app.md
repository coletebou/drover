# Window 1: macOS app (Apps/macOS)
SwiftUI, macOS 14+. Three-column layout like the web board: sidebar (hosts, views), board (Waiting on you /
Working / Idle strips), detail (Chat, Screen, Info). Chat composer with send-to-session vs to-pane, key buttons
(Enter, Esc, y, n, 1,2,3), command palette (Cmd+K), live updates via DroverKit EventStream, notifications
(UserNotifications) with Reply/Open actions, per-category sound settings, Settings scene (server URL, token
in Keychain, notification rules, quiet hours), drag-and-drop images into the composer (upload op may not exist: write
the file path flow only if the server has an upload op, else disable), light/dark, keyboard navigation (j/k, enter, r).
Depends on DroverKit API shape from CONTRACT.md: code against it; if DroverKit is not merged yet, stub the
protocol in your own dir and swap later. Slices: board+detail, chat+composer, settings+notifications, palette+shortcuts.
