import Foundation
import Testing
@testable import GoonCave

private let server = URL(string: "https://cave.example")!

@Suite struct ServerAddressTests {
    @Test func recentServersKeepTheLastThreeDistinctOrigins() {
        let recent = ServerAddress.recent([
            "https://one.example/", "https://two.example", "https://three.example"
        ], adding: URL(string: "https://four.example")!)
        #expect(recent == ["https://four.example", "https://one.example", "https://two.example"])
    }

    @Test func reconnectingMovesTheSameOriginToTheFront() {
        let recent = ServerAddress.recent([
            "https://one.example", "https://two.example", "https://three.example"
        ], adding: URL(string: "https://TWO.example:443/")!)
        #expect(recent == ["https://two.example", "https://one.example", "https://three.example"])
    }

    @Test func recentServersRejectInvalidSavedAddressesAndKeepDistinctPorts() {
        #expect(ServerAddress.recent([
            "http://one.example", "https://user:secret@one.example", "https://one.example/app",
            "https://one.example/", "https://one.example:8443", "https://ONE.example"
        ]) == ["https://one.example", "https://one.example:8443"])
    }

    @Test(arguments: ["https://cave.example", "https://cave.example/", " https://cave.example:8443 "])
    func acceptsHTTPSOrigins(_ text: String) {
        #expect(ServerAddress.parse(text) != nil)
    }

    @Test(arguments: [
        "http://cave.example",
        "cave.example",
        "https://",
        "https://user:pass@cave.example",
        "https://cave.example/app",
        "https://cave.example/?next=1",
        "https://cave.example/#top",
    ])
    func rejectsAnythingButAnOrigin(_ text: String) {
        #expect(ServerAddress.parse(text) == nil)
    }
}

@Suite struct SiteRouteTests {
    private func route(_ address: String) -> SiteRoute? {
        SiteRoute(url: URL(string: address)!, server: server)
    }

    @Test func ignoresOtherOrigins() {
        #expect(route("https://other.example/app/gallery") == nil)
        #expect(route("http://cave.example/app/gallery") == nil)
        #expect(route("https://cave.example:8443/app/gallery") == nil)
    }

    @Test func loginHidesTabs() {
        #expect(route("https://cave.example/login?redirect=%2Fapp%2Fgallery")?.showsTabs == false)
    }

    @Test func detailNeedsANonEmptyParameter() {
        #expect(route("https://cave.example/app/gallery?fileId=42")?.showsDetail == true)
        #expect(route("https://cave.example/app/gallery?fileId=")?.showsDetail == false)
        #expect(route("https://cave.example/app/explore?post=7")?.showsDetail == true)
        #expect(route("https://cave.example/app/explore?fileId=42")?.showsDetail == false)
    }

    @Test func onlyTheSettingsMainPageIsSettingsHome() {
        #expect(route("https://cave.example/app/settings")?.isSettingsHome == true)
        #expect(route("https://cave.example/app/settings/folders")?.isSettingsHome == false)
        #expect(route("https://cave.example/app/gallery")?.isSettingsHome == false)
    }
}

@Suite struct RecoveryMessageTests {
    private func message(_ code: URLError.Code?, localNetworkDenied: Bool = false) -> String? {
        recoveryMessage(code: code, description: "Details.", host: "cave.example", localNetworkDenied: localNetworkDenied)
    }

    @Test func noNetworkMeansOffline() {
        #expect(message(.notConnectedToInternet) == nil)
        #expect(message(.networkConnectionLost) == nil)
    }

    // iOS reports a denied Local Network privilege as having no connection.
    @Test func localNetworkDenialWinsOverTheReportedError() {
        #expect(message(.notConnectedToInternet, localNetworkDenied: true)?.contains("Local Network") == true)
    }

    @Test func eachFailureNamesItsFix() {
        #expect(message(.serverCertificateUntrusted)?.contains("certificate") == true)
        #expect(message(.cannotFindHost)?.contains("cannot find cave.example") == true)
        #expect(message(.timedOut)?.contains("did not answer") == true)
        #expect(message(.dataNotAllowed)?.contains("Mobile data") == true)
        #expect(message(.badServerResponse) == "The server request failed: Details.")
        #expect(message(nil) == "The server request failed: Details.")
    }
}

@Suite struct SessionSignatureTests {
    private func cookie(_ name: String, _ value: String, httpOnly: Bool = true, expires: String = "Wed, 01 Jan 2031 00:00:00 GMT") -> HTTPCookie {
        let header = "\(name)=\(value); Path=/; Expires=\(expires)" + (httpOnly ? "; HttpOnly" : "")
        return HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: server)[0]
    }

    @Test func renewingTheSessionIsNotAChange() {
        let before = sessionSignature([cookie("gooncave_session", "a", expires: "Mon, 01 Jan 2029 00:00:00 GMT")])
        let after = sessionSignature([cookie("gooncave_session", "a", expires: "Tue, 01 Jan 2030 00:00:00 GMT")])
        #expect(before == after)
    }

    @Test func signingInOutOrSwitchingAccountIsAChange() {
        let signedIn = sessionSignature([cookie("gooncave_session", "a")])
        #expect(signedIn != sessionSignature([]))
        #expect(signedIn != sessionSignature([cookie("gooncave_session", "b")]))
    }

    @Test func scriptReadableCookiesAreIgnored() {
        #expect(sessionSignature([cookie("theme", "dark", httpOnly: false)]).isEmpty)
    }
}
