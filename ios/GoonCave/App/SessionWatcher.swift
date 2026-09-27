import Observation
import WebKit

/// Counts sign-ins, sign-outs, and account switches in the shared cookie store,
/// so tabs that did not see the change can reload. Only one server's cookies
/// exist at a time because changing server clears the store.
@MainActor @Observable
final class SessionWatcher: NSObject, WKHTTPCookieStoreObserver {
    private(set) var generation = 0
    @ObservationIgnored private var signature: Set<String>?
    @ObservationIgnored private let store = WKWebsiteDataStore.default().httpCookieStore

    override init() {
        super.init()
        store.add(self)
        Task { await refresh() }
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor in await self.refresh() }
    }

    private func refresh() async {
        let next = sessionSignature(await store.allCookies())
        if let signature, signature != next { generation += 1 }
        signature = next
    }
}

/// The session cookie is HttpOnly. Renewing it changes only its expiry, which
/// this signature ignores.
func sessionSignature(_ cookies: [HTTPCookie]) -> Set<String> {
    Set(cookies.filter(\.isHTTPOnly).map { "\($0.domain) \($0.name)=\($0.value)" })
}
