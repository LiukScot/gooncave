import Foundation
import Network

/// Recovery text for a failed request to the user's server, or nil when the
/// iPhone has no network and callers should show the offline state. Checks the
/// Local Network privilege first, because URLSession and WebKit report that
/// denial as the same error as having no connection.
func recoveryMessage(for error: Error, server: URL) async -> String? {
    recoveryMessage(
        code: (error as? URLError)?.code,
        description: error.localizedDescription,
        host: server.host ?? server.absoluteString,
        localNetworkDenied: await isLocalNetworkDenied(server)
    )
}

func recoveryMessage(code: URLError.Code?, description: String, host: String, localNetworkDenied: Bool) -> String? {
    if localNetworkDenied {
        return "iOS blocked access to \(host) on your local network. Turn on GoonCave in Settings › Privacy & Security › Local Network, then try again."
    }
    guard let code else {
        return "The server request failed: \(description)"
    }
    switch code {
    case .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
         .serverCertificateHasBadDate, .serverCertificateNotYetValid,
         .secureConnectionFailed, .clientCertificateRequired, .clientCertificateRejected:
        return "This iPhone does not trust the HTTPS certificate of \(host). Use a certificate from a public authority such as Let's Encrypt, or install and trust your own certificate authority on this iPhone."
    case .cannotFindHost, .dnsLookupFailed:
        return "This iPhone cannot find \(host). Check the address, or connect to the network or VPN that knows it."
    case .notConnectedToInternet, .networkConnectionLost:
        return nil
    case .cannotConnectToHost, .timedOut:
        return "\(host) did not answer. Check that GoonCave is running and reachable from this iPhone's network or VPN."
    case .dataNotAllowed:
        return "Mobile data is off for GoonCave. Turn it on in Settings › GoonCave, or connect to Wi-Fi."
    default:
        return "The server request failed: \(description)"
    }
}

// NWConnection is the only API that exposes the denial; see Apple TN3179.
private func isLocalNetworkDenied(_ server: URL) async -> Bool {
    guard let host = server.host,
          let port = NWEndpoint.Port(rawValue: UInt16(server.port ?? 443)) else { return false }
    let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
    let queue = DispatchQueue(label: "LocalNetworkProbe")
    return await withCheckedContinuation { continuation in
        var resumed = false
        let finish: (Bool) -> Void = { denied in
            guard !resumed else { return }
            resumed = true
            connection.cancel()
            continuation.resume(returning: denied)
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .waiting:
                finish(connection.currentPath?.unsatisfiedReason == .localNetworkDenied)
            case .ready, .failed, .cancelled:
                finish(false)
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 3) { finish(false) }
    }
}
