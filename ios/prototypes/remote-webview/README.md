# Remote WebView candidate for issue #414

This is a comparison prototype, not the selected iOS architecture or a release.
It opens the existing server-hosted React application in a persistent WKWebView.
The server address is entered on the phone and must use valid HTTPS. The
provisional deployment target is iOS 17; the production minimum is undecided.
The prototype bundle ID is `app.gooncave.remote-prototype`.

The setup screen checks `/health` before opening the site. That endpoint reports
availability only. It does not identify an API version or prove compatibility.
For a development-only React/CSS preview on an iPhone, follow
[the live preview setup](../../dev-preview.md).
The app keeps WebView cookies across launches. Login, protected media, downloads,
uploads, logout, navigation, and update behavior still require device tests.

The navigation experiment removes the native title bar and uses the system
TabView for Explore, Gallery, Games, and Settings. Each web section owns a
WKWebView and shares WebKit's persistent cookie store. Settings and the login
screen expose Change server. The WebView hides the site's mobile tab bar only
inside this prototype. Tab switching needs device checks for scroll, detail
state, and media playback.
The system tab bar hides while a Gallery file (`fileId`) or Explore post
(`post`) detail is open, and returns when the detail closes. This is separate
from the login state so the Change server button does not cover opened media.
Same-page URL changes are reported to the native shell. Website links keep
using their current WKWebView, including related posts opened from Gallery;
only a tap on the native bar switches to another tab's WKWebView.
Games displays a native placeholder, so the tab can be tested against a server
that still hides the website's Games route. The website change that makes Games
permanent takes effect when the updated frontend is deployed to the server.
The top safe area has a material blur tinted with the page's
`--page-background` color at rest. The tint is darker than the page token to
offset the material's brightening measured on the iPhone; the material remains
translucent while content scrolls. On iOS 26 and later, the web view also uses the
system background extension effect to blur content into that inset. The system
owns the tab bar's height, position, appearance, and selection animation. The website reserves
space for the native bar only inside this prototype so the final gallery row
remains reachable.

The `iOS remote shell prototype` workflow builds an unsigned iPhone IPA on hosted
macOS and uploads it as a temporary CI artifact. It does not publish a release.
The user must re-sign the artifact with a compatible installer before installing.
Record the KravaSign version, iOS version, and signing-account class alongside
the results. Do not include a private server URL or credentials in test output.

Source for the comparison and test steps: `ios/shell-evaluation.md`.
