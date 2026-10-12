# GoonCave iPhone app

The iPhone app opens the existing GoonCave server in a persistent WKWebView. It is
the release target for iOS 0.1.0. The version number in the build is a release
candidate until the device checks pass and a GitHub Release is published.

| Property | Value |
| --- | --- |
| Bundle identifier | `app.gooncave` (never change it after the first release) |
| Minimum iOS | 26.0 |
| Devices | iPhone |
| Server contract | `apiVersion` 1 from `/health` |

## Behavior

On first launch the app asks for the server's HTTPS address and stores it on the
phone.

The Server screen lists up to three recently connected servers, newest first.
Tap one to connect without typing its address. The list persists on the phone
and updates only after a successful health and API compatibility check.
Failed connections do not replace a recent server. Reconnecting to the same
origin moves it to the top without duplicating it or clearing its session.

Before opening the site it checks `/health`:

- a supported `apiVersion` opens the site;
- a missing or older version asks to update the server;
- a newer version asks to install a newer app;
- no network shows an offline screen that retries when the connection returns;
- any other failure shows a recovery message with Try again and Change server.
  Denied Local Network permission, untrusted HTTPS certificates, unknown hosts,
  and servers that do not answer each get their own message.

Connecting to a different server first deletes all website data (cookies, cache,
storage), so no session or media of the previous server survives the change.

Losing the network while the site is open covers it until the connection returns,
keeping the page state. WebView cookies persist across launches, so the server's
session survives relaunch until it expires. When a request fails because the
session expired or was revoked, the site returns to login and then to the same
page. Signing in, signing out, or switching account reloads the hidden tabs. If
iOS ends a page's process while the phone is locked, the page reloads.

Explore, Gallery, and Settings each use their own WKWebView with the shared cookie
store; Games shows a native placeholder. The native tab bar replaces the site's
mobile tab bar and hides while a Gallery file (`fileId`) or Explore post (`post`)
is open. Links inside the site stay in the current tab. The Settings main page and
the login screen expose Change server; Settings subpages do not.

## Build, test, and install

The `iOS app` workflow builds an unsigned versioned IPA on hosted macOS for pull
requests that change this directory, and uploads it with build metadata and the
license as a CI artifact. It also runs
the unit tests in `Tests/` on an iOS simulator. It does not
publish a release: the `Weekly release` workflow does, see
[Publishing a release](../../docs/versioning.md#publishing-a-release). Re-sign the IPA with a compatible installer before installing.
Signed distribution is tracked in #420.

The first release requires an existing GoonCave server with `/health` API version
1. Download the versioned IPA from the GitHub Release, then sign and install it
with a compatible installer. Use the same installer, signing account, and bundle
identifier when updating over an existing installation so app settings remain.
Refresh the app's signing through the installer before its signing period expires.
If the app no longer opens, refresh its signing in the installer before removing
the app; removing it can erase its local settings. The IPA is not an App Store
package and does not contain a server or a standalone library.

The repository's [GPLv3 license](../../LICENSE) applies to the app and backend.
The iPhone target uses Apple's system frameworks and has no third-party packages
to bundle with the IPA. GitHub's source archive for the release tag contains the
license and corresponding source.

For React/CSS changes without a new IPA, use [the live preview](../dev-preview.md).

Device results and the shell decision are recorded in
[the shell evaluation](../shell-evaluation.md).
