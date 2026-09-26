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
}
