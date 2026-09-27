import Foundation

/// What the native shell shows for a page of the user's server.
struct SiteRoute: Equatable {
    /// The page belongs to the signed-in app, so the native tab bar applies.
    let showsTabs: Bool
    /// A Gallery file or Explore post is open and covers the whole screen.
    let showsDetail: Bool
    let isSettingsHome: Bool

    /// Returns nil for a URL outside the server origin.
    init?(url: URL, server: URL) {
        guard url.scheme == server.scheme, url.host == server.host, url.port == server.port else {
            return nil
        }
        showsTabs = url.path.hasPrefix("/app")
        isSettingsHome = url.path == "/app/settings"
        let detailParameter: String? = switch url.path {
        case "/app/gallery": "fileId"
        case "/app/explore": "post"
        default: nil
        }
        showsDetail = detailParameter.map { name in
            URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.contains { $0.name == name && !($0.value ?? "").isEmpty } ?? false
        } ?? false
    }
}
