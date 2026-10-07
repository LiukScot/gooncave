import Foundation

enum ServerAddress {
    static let recentLimit = 3

    /// Canonical origin for an address already accepted by `parse`.
    static func origin(_ address: URL) -> String {
        var components = URLComponents(url: address, resolvingAgainstBaseURL: false)!
        components.scheme = "https"
        components.host = components.host?.lowercased()
        components.path = ""
        if components.port == 443 { components.port = nil }
        return components.string!
    }

    static func recent(_ addresses: [String], adding address: URL? = nil) -> [String] {
        let candidates = (address.map { [origin($0)] } ?? []) + addresses
        var result: [String] = []
        for candidate in candidates {
            guard let parsed = parse(candidate) else { continue }
            let normalized = origin(parsed)
            if !result.contains(normalized) { result.append(normalized) }
            if result.count == recentLimit { break }
        }
        return result
    }

    /// Accepts only an HTTPS origin, optionally with a trailing slash.
    static func parse(_ text: String) -> URL? {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else {
            return nil
        }
        return components.url
    }
}
