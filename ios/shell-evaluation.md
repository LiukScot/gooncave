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
The native bar, route switching, and bottom safe area still need device evidence.

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

## Next evidence step

Run both read-only GitHub Actions workflows against the same source revision.
Inspect the device artifacts, then install and test them on the iPhone. If the
Capacitor probe shows a cross-origin session or media failure, record the exact
request and design a safe transport before attempting the full React interface.
Do not publish a release from these experiments.

The architecture audit is in `docs/feasibility/ios.md`; the build route is in
`docs/feasibility/ios-distribution.md`; device gates are in
`docs/feasibility/ios-validation.md`.
