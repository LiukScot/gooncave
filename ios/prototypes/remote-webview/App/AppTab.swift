import Foundation

enum AppTab: String, CaseIterable, Identifiable {
    case explore, gallery, games, settings

    var id: Self { self }
    var path: String { "app/\(rawValue)" }
    var title: String { rawValue.capitalized }

    var symbol: String {
        switch self {
        case .explore: "safari"
        case .gallery: "photo.on.rectangle"
        case .games: "gamecontroller"
        case .settings: "gearshape"
        }
    }

    init?(url: URL) {
        let parts = url.path.split(separator: "/")
        guard parts.first == "app", parts.count > 1,
              let tab = Self(rawValue: String(parts[1])) else { return nil }
        self = tab
    }
}
