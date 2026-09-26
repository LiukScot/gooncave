# iOS 0.1.0 shell evaluation

Issue: [#414](https://github.com/LiukScot/gooncave/issues/414). Status: no shell selected.
The release uses the existing server. Later releases add local capabilities to
the same app. The two candidates reuse the current React interface differently.

The [remote WebView candidate](prototypes/remote-webview/README.md) has source
and a device-build workflow. The [Capacitor candidate](prototypes/bundled-capacitor/README.md)
has a separate React transport probe and device-build workflow. Neither has
been compiled for iPhone or installed. The Capacitor probe tests the network
boundary before reusing the whole interface; it is not a feature-parity client.

| Candidate | React assets | API and media origin | Native code needed for this experiment |
| --- | --- | --- | --- |
| Remote WKWebView | Served by the user's GoonCave server | Same as the page | Server setup, WebView navigation, connection errors |
| Bundled React with Capacitor | Included in the IPA | Separate from the user's server | Server setup, API transport, cookie/session and media handling |

The server currently serves the UI and API together (`backend/src/index.ts`).
The production frontend uses the page origin for API requests
(`frontend/src/api.ts`). Session cookies are set by the server
(`backend/src/routes/auth.ts`). The bundled candidate cannot be assumed to
preserve these properties merely because its login page renders.

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
