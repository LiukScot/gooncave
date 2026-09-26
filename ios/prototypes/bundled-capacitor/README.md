# Bundled Capacitor transport candidate for issue #414

This is a narrow comparison probe, not the GoonCave iOS interface. It bundles a
small React page into an IPA and calls the existing server from Capacitor's app
origin. It tests server setup, login response, session persistence, file listing,
and protected image/video requests. It does not implement uploads, downloads,
navigation parity, or a production authentication transport.

The test uses the same valid HTTPS server as the remote WebView candidate. The
server address stays on the phone; no URL or credential is baked into the IPA.
The prototype bundle ID is `app.gooncave.bundledprototype`. Capacitor generated
an iOS 15 deployment target; the release minimum remains undecided.

The existing server uses `SameSite=Strict` cookies. A successful login response
from the app origin does not establish that later requests or media can use the
session. Record each result separately. Do not relax the server's cookie or CORS
policy merely to make this probe pass; a production transport needs its own
design and security review.

The `iOS bundled transport prototype` workflow builds an unsigned `iphoneos`
IPA and uploads it as a temporary CI artifact. It does not publish a release.
Re-sign the artifact with KravaSign before installation, then follow the
[shell evaluation](../../shell-evaluation.md).
