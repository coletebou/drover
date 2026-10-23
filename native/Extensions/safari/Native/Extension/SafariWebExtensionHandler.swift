import Foundation
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    /// Carries the extension context into a Task. `NSExtensionContext` is not Sendable, but it is only used
    /// once, from that Task, to call `completeRequest` (documented as callable from any thread) after the
    /// router finished; nothing else touches it meanwhile. All non-Sendable work (building the reply item,
    /// reading the context) stays inside this type's method, so the Task closure below captures nothing but
    /// Sendable values and makes a single call (no `Self` metatype, no field projection, no local non-Sendable).
    private struct ContextBox: @unchecked Sendable {
        let context: NSExtensionContext

        func run(_ request: Result<NativeRequest, NativeError>, router: NativeRouter) async {
            let response = await router.handle(parsed: request)
            let reply = NSExtensionItem()
            reply.userInfo = [SFExtensionMessageKey: response.jsonObject]
            context.completeRequest(returningItems: [reply], completionHandler: nil)
        }
    }

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        // Parse synchronously: the raw message is not Sendable, the parsed request is.
        let request = NativeRequest.parse(item?.userInfo?[SFExtensionMessageKey])
        let router = Self.makeRouter()
        let box = ContextBox(context: context)

        Task { await box.run(request, router: router) }
    }

    private static func makeRouter() -> NativeRouter {
        #if os(macOS)
        let platform = "macOS"
        #else
        let platform = "iOS"
        #endif
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let credentials = SharedCredentialStore(config: .fromBundle())
        return NativeRouter(
            credentials: credentials,
            // Alerts carry the server they came from, so the Mac app will not send a Reply to a server it switched to.
            notifier: UserNotificationPoster(server: credentials.baseURL()?.absoluteString),
            http: URLSessionHTTP(),
            platform: platform,
            version: version)
    }
}
