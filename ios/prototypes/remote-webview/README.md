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

The `iOS remote shell prototype` workflow builds an unsigned iPhone IPA on hosted
macOS and uploads it as a temporary CI artifact. It does not publish a release.
The user must re-sign the artifact with a compatible installer before installing.
Record the KravaSign version, iOS version, and signing-account class alongside
the results. Do not include a private server URL or credentials in test output.

Source for the comparison and test steps: `ios/shell-evaluation.md`.
