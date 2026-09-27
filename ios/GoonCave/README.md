# GoonCave iPhone app

The iPhone app opens the existing GoonCave server in a persistent WKWebView. It is
the release target for iOS 0.1.0 and has not been released yet.

| Property | Value |
| --- | --- |
| Bundle identifier | `app.gooncave` (never change it after the first release) |
| Minimum iOS | 26.0 |
| Devices | iPhone |
| Server contract | `apiVersion` 1 from `/health` |

## Behavior

On first launch the app asks for the server's HTTPS address and stores it on the
phone. Before opening the site it checks `/health`:

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

The `iOS app` workflow builds an unsigned `GoonCave.ipa` on hosted macOS for pull
requests that change this directory, and uploads it as a CI artifact. It also runs
the unit tests in `Tests/` on an iOS simulator. It does not
publish a release. Re-sign the IPA with a compatible installer before installing.
Signed distribution is tracked in #420.

For React/CSS changes without a new IPA, use [the live preview](../dev-preview.md).

Device results and the shell decision are recorded in
[the shell evaluation](../shell-evaluation.md).
