# iOS 0.1.0 shell evaluation

Issue: [#414](https://github.com/LiukScot/gooncave/issues/414). Status: no shell selected.
The release uses the existing server. Later releases add local capabilities to
the same app. The two candidates reuse the current React interface differently.

The [remote WebView candidate](prototypes/remote-webview/README.md) has source
and a device-build workflow. The [Capacitor candidate](prototypes/bundled-capacitor/README.md)
has a separate React transport probe and device-build workflow. Both workflows
have produced iPhone IPAs. The Capacitor probe tests the network boundary before
reusing the whole interface; it is not a feature-parity client.

On an iPhone 15 Pro running iOS 27, the user installed both prototypes and
provided screenshots. The visible server button and the existing GoonCave login
form identify the remote WebView candidate. This confirms installation, launch,
and rendering of the server-hosted login page. A later screenshot of the same
candidate shows Gallery with a nonzero item count and visible thumbnails. This
supports successful sign-in and loading of gallery data and thumbnails on that
device. Session persistence after relaunch, original media, video, upload, and
download remain unverified in the screenshots.

The user later reported that reopening the app, media playback, and navigation
seem to work. Detailed results for original image, video seeking, upload, and
download were not recorded separately. The first remote IPA showed unused black
space below the app, enlarged content, and Gallery order controls beyond the
right edge. Its packaged `Info.plist` had no launch-screen declaration. The
rebuilt IPA includes `UILaunchStoryboardName` and a compiled launch storyboard.
A screenshot from that build on the same iPhone shows the app using the available
display area at the expected scale, with all Gallery order buttons visible.
The native display-sizing issue is resolved on this device. The web page already
declares a device-width viewport; its zoom settings did not need to change.

The next remote-shell build tests a native bottom bar and removes the top title
and server button. The bottom bar should occupy the home-indicator inset rather
than leave an unused black strip. Its four routes are Explore, Gallery, Games,
and Settings. Games shows a native placeholder until the updated website is
deployed; the website tab is also permanent in the updated frontend.
The custom floating bar and top material proved visually wrong on the device:
the bar was too tall and lacked the system selection animation, while the top
material left a gray block below the status area. A color-only top fix rendered
black on the iPhone. The next build uses a tinted blur confined to the status
inset and the system background extension effect, alongside the system TabView. Its bar,
route switching, and final-row reachability still need device evidence.
The device screenshots of that build confirm the blur and show the resting
status inset at RGB (26, 28, 30) against the page at (18, 19, 22). The next
build darkens the material tint while keeping its 70% opacity; the resting
match and the blurred scrolling state need device confirmation.
The remote shell detects Gallery file and Explore post detail URLs and requests
that the native tab bar hide. On-device validation must confirm it disappears on
opening media and returns after closing or using back navigation.
A device report confirms the native system bar has the desired Liquid Glass
appearance and that login survives reopening. The first build left the bar
visible over Gallery images. Moving SwiftUI's tab-bar visibility preference to
each tab's content fixed that behavior in a later device build. The resulting
bar transition was abrupt; the next build animates the visibility state change
and respects Reduce Motion. Its appearance still needs device validation.
A device recording showed two failures: the bar remained over an open detail,
and tapping a related parent post jumped to the Explore feed. The site passed
the post through its in-memory state while changing its URL; the shell swapped
to Explore's separate WKWebView and lost that state. The updated shell observes
same-page URL changes and keeps website links in the current WKWebView. The
device must verify both behaviors before this experiment is considered sound.

The bundled Capacitor candidate also launches and renders its packaged React
probe. Its login attempt displays `Login request failed: TypeError: Load failed`.
The probe did not receive an HTTP response that it could display. This does not
identify the cause: WebKit may reject the cross-origin request, a preflight may
fail, or transport/TLS may fail. The server allows credentialed cross-origin
requests only for configured origins, and its session cookie uses
`SameSite=Strict`. Check the request and server logs before changing either
policy. Session, file, and protected media results remain unverified.

| Candidate | React assets | API and media origin | Native code needed for this experiment |
| --- | --- | --- | --- |
| Remote WKWebView | Served by the user's GoonCave server | Same as the page | Server setup, WebView navigation, connection errors |
| Bundled React with Capacitor | Included in the IPA | Separate from the user's server | Server setup, API transport, cookie/session and media handling |

The server currently serves the UI and API together (`backend/src/index.ts`).
The production frontend uses the page origin for API requests
(`frontend/src/api.ts`). Session cookies are set by the server
(`backend/src/routes/auth.ts`). The bundled candidate cannot be assumed to
preserve these properties merely because its login page renders.

## Fast feedback during development

The current IPAs are comparison builds, not Expo development builds or a
configured local live-reload environment. EAS Build creates iOS binaries for
Expo projects; an Expo development build connects to a local JavaScript server
and receives JavaScript/UI edits without another native build. GoonCave's
existing interface uses React DOM, so adopting that Expo workflow would require
rewriting the interface in React Native. See the
[Expo development-build guide](https://docs.expo.dev/develop/development-builds/introduction/)
and the [architecture comparison](../docs/feasibility/ios.md).

For this repository, a development-only shell can load the existing React UI
from a Vite server on the Linux host. The iPhone and host must reach each other
over Wi-Fi or VPN; API requests and login must also work through the development
origin. Test the live connection with the remote WebView candidate or with
Capacitor's `server.url` before choosing a path. The observed Capacitor login
failure means its API transport cannot be assumed to work. Capacitor documents
`server.url` for live reload and excludes it from production builds. See
[Capacitor configuration](https://capacitorjs.com/docs/config). Build and install
the native development IPA once; frontend edits can then reload from Vite.
Native Swift, Capacitor plugin, and iOS configuration changes still require a
new IPA. This experiment has not been implemented or validated on the phone.

## Evidence to collect from both candidates

Use the same server, account, iPhone, installer, and media fixtures. The planned
device is an iPhone 15 Pro with iOS 27, KravaSign 2.8.2, and a distribution
certificate. Record the source commit, build toolchain, IPA hash, and server
revision for each build.

1. Build for `iphoneos` on hosted macOS and inspect the generated `.app` and IPA.
2. Re-sign and install with KravaSign on the iPhone 15 Pro. Relaunch and update
   the same bundle identity without deleting the first installation.
3. Enter a valid HTTPS server address, sign in, force quit, and reopen. Confirm
   the session behaves like the server's documented expiry policy.
4. Load a protected thumbnail and original, play and seek a protected video,
   upload a file, and save a download. Record failures by request type.
5. Open Gallery, Explore, a post, a pool, and settings. Test back navigation,
   selected item, scroll position, keyboard, and an external provider link.
6. Disconnect the server, restore connectivity, and enter a server that does not
   provide the expected API. Verify visible recovery and compatibility messages.
7. Record what would have to change to add local storage and native provider
   requests later without breaking the server mode.

Minimum supported iOS, production bundle identifier, compatibility protocol,
and the selected shell remain decisions after the device evidence. The current
`/health` endpoint reports availability, not an API version, so it cannot prove
client/server compatibility by itself.

## Current #414 decision gate

The server-client feature inventory is recorded in
[`server-client-inventory.md`](server-client-inventory.md). Both candidates have
produced unsigned `iphoneos` IPAs through their hosted macOS workflows. The
latest remote-shell build succeeded at source commit
`77afa550fbc51e055204d7cffe58aa7d344088c7`. A later remote-shell build
at `298d17c9f0d88c1e5bd8354b84fe9ba7a70ee83d` succeeded, and the owner
confirmed its bar hides over Gallery images. A successful build alone does not
establish media transfer or complete navigation on the phone.

Build the animated remote shell for iPhone and test it before selecting it.
Open and close a Gallery file and an Explore post; confirm that the bar moves
smoothly and returns without covering media or moving the reading position.
Check Reduce Motion separately. Record protected original, video seeking,
upload, and download results separately. Use the same server and media fixtures
for the bundled candidate.

The bundled probe's login failed before an HTTP response was available to the
page. Record the failing request and server-side result before assigning a cause.
The server allows credentialed CORS only from configured origins and sets its
session cookie to `SameSite=Strict`; a different app origin cannot be assumed to
carry that cookie on later API or media requests. Do not relax either policy to
make the probe pass. A bundled client needs a reviewed transport that handles
login, API calls, protected media, uploads, and logout together.

After these tests, record the selected shell, minimum supported iOS version,
production bundle identity, and explicit client/server compatibility check.
The current `/health` response proves availability only. Keep both IPAs as
experimental artifacts until the release gates pass.

The architecture audit is in `docs/feasibility/ios.md`; the build route is in
`docs/feasibility/ios-distribution.md`; device gates are in
`docs/feasibility/ios-validation.md`.
