# Remote WebView candidate for issue #414

This is a comparison prototype, not the selected iOS architecture or a release.
It opens the existing server-hosted React application in a persistent WKWebView.
The server address is entered on the phone and must use valid HTTPS. The
provisional deployment target is iOS 17; the production minimum is undecided.
The prototype bundle ID is `app.gooncave.remote-prototype`.

The setup screen checks `/health` before opening the site. That endpoint reports
availability only. It does not identify an API version or prove compatibility.
The app keeps WebView cookies across launches. Login, protected media, downloads,
uploads, logout, navigation, and update behavior still require device tests.

The navigation experiment removes the native title bar and places Explore,
Gallery, Games, and Settings in a native bottom bar. The same WebView remains in
use while switching sections. Settings opens a native menu with GoonCave
settings and Change server. The login screen shows Change server below the page.
The WebView hides the site's mobile tab bar only inside this prototype. Native
tab selection loads the corresponding server route, so it currently reloads
the page and needs device checks for scroll, detail state, and media playback.
Games remains a placeholder; the website change that makes its route always
available must be deployed to the server before this tab can be validated.

The `iOS remote shell prototype` workflow builds an unsigned iPhone IPA on hosted
macOS and uploads it as a temporary CI artifact. It does not publish a release.
The user must re-sign the artifact with a compatible installer before installing.
Record the KravaSign version, iOS version, and signing-account class alongside
the results. Do not include a private server URL or credentials in test output.

Source for the comparison and test steps: `ios/shell-evaluation.md`.
