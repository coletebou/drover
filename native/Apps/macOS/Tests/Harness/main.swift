import Foundation

await CoreTests.run()
await BoardTests.run()
await ChatTests.run()
await SettingsTests.run()
await PaletteTests.run()
await PairingTests.run()
await RoutingTests.run()
await BoardDecodeTests.run()
await SSETests.run()
await TranscriptTests.run()
await DialogTests.run()
await ManagerTests.run()
await NotificationTests.run()
await ApprovalTests.run()

print("harness: \(T.passes) passed, \(T.failures) failed")
exit(Int32(min(T.failures, 255)))
