# iOS implementation gates and device validation

Status: proposed acceptance plan, 2026-09-26. **Every device gate below is pending.**
This audit produced documentation, not an implementation or a working IPA.

Related: [architecture audit](ios.md), [build/distribution guide](ios-distribution.md).

## 1. Scope the first release

Before creating an app target, record these decisions in its implementation issue:

- Record the selected release behavior: complete server mode at 0.1.0, followed
  by local capabilities in the same app through 1.0.0.
- Record iPhone model, iOS version, installer/version, and signing-account class.
- Choose minimum supported iOS and a baseline device with realistic memory/storage.
- Choose providers and features required for the first useful release.
- Specify which data is local, remote, cached, exported, and erased at logout.
- Specify behavior without network, after signing expiry, and after force quit.

The product mode is selected: server-connected iOS 0.1.0, then incremental local
features through iOS 1.0.0 with both modes retained. The browser-only ADR is
withdrawn. See [the active iOS roadmap](../../ios/README.md).

## 2. Step → evidence → decision

| Gate | Implement / inspect | Pass evidence | Failure consequence |
| --- | --- | --- | --- |
| G0: installation | Minimal app, hosted macOS device build, re-sign/install | Owner installs, launches, refreshes, and updates without a Mac | Resolve installation route before porting features |
| G1: client connection | Server setup, login, media, upload, logout | Same signed build completes all paths after cold restart | Revisit same-origin shell versus bundled/native auth |
| G2: standalone provider | One provider with native transport | Search, media, favorite/unfavorite, error recovery, persisted state | Stop broad provider port; identify transport/auth blocker |
| G3: persistence | Local database/files/export and schema upgrade | Data survives restart/update; restore works; interrupted write recovers | No standalone release until data-loss risk is addressed |
| G4: lifecycle | Download/sync cancellation and continuation | Measured suspension/termination behavior matches UI promises | Reduce background claims or retain server work |
| G5: usability | Real iPhone route/media/touch tests | All core actions usable; no unreadable/hidden controls or content jumps | Fix before advertising iOS support |
| G6: release | Clean build, artifact inspection, source metadata | Exact tested IPA and metadata match; update path succeeds | Keep output as an experimental CI artifact |

G1 is required for a server-connected edition. G2/G3 are required for standalone.
A hybrid requires both and tests for switching modes. Do not expand to all engines
before one provider completes an end-to-end path.

## 3. Build artifact checks

- Confirm the binary targets `iphoneos`, not `iphonesimulator`.
- Confirm the executable named by `CFBundleExecutable` exists and is executable.
- Confirm bundle identifier, product/build version, minimum OS, and device family.
- Confirm all embedded frameworks/extensions match the device architecture/platform.
- Confirm the IPA contains `Payload/<App>.app` at archive root.
- Confirm production assets are bundled when that architecture requires them.
- Confirm no local `.env`, databases, credentials, logs, signing keys, or library
  media are included.
- Inspect the final permission/entitlement set and test re-signing those capabilities.
- Record exact source SHA, toolchain, dependency locks, artifact hash, and byte size.
- Verify the download URL returns the intended asset without a GitHub login.
- Validate source-feed fields against the actual artifact and installed version.

These checks can be automated after an iOS target exists. A successful Xcode build
alone does not pass installation or application behavior gates.

## 4. Server-connected phone tests

| Action | Expected result |
| --- | --- |
| Launch with no configured server | Setup screen explains what server is needed and accepts a URL |
| Enter an unreachable or malformed URL | Actionable error; change/retry remains available |
| Connect to a valid HTTPS server | API compatibility and login screen load |
| Deny LAN access, then grant it | Explicit recovery; connection succeeds after permission is restored |
| Present an invalid TLS certificate | Connection fails visibly; no silent trust bypass |
| Log in, kill/reopen, lock/unlock | Session behavior matches expiry policy; no unexplained login loop |
| Open thumbnails, originals, and video; seek | All media authorizes correctly; range requests seek without full refetch |
| Upload selected Files/Photos content | Correct server destination, progress, cancellation, and useful rejection errors |
| Switch server/account | No thumbnails, records, credentials, or cached queries leak across identities |
| Log out and reopen | Protected data no longer loads using an old session |
| Start a server sync, background the app | Server job continues; UI reconnects to accurate progress |
| Use an incompatible/older server | Clear compatibility message instead of broken controls |

Test same-network access and the intended remote HTTPS/VPN arrangement separately.
Changing `localhost` to a LAN address can expose host-scoped cookie assumptions.

## 5. Standalone provider tests

Run this flow for every advertised provider/engine instance:

1. Add credentials using only tools available on the supported iPhone workflow.
2. Search, paginate, view a thumbnail, and open an original/video.
3. Add a favorite and verify the provider's actual state.
4. Remove that favorite and verify removal, including cookie-backed action paths.
5. Exercise voting, subscriptions, pools, and relations only where supported.
6. Persist blacklist/read marks and restart the app.
7. Expire/revoke credentials and confirm a recognizable reauthentication flow.
8. Simulate offline, timeout, 429, server failure, and deleted/private posts.
9. Cancel work and verify no delayed request overwrites a newer user choice.
10. Verify provider credentials are absent from logs, exports, and unrelated hosts.

Record transport type, target host, API versus media behavior, and whether the
request ran through WebView or native networking. Redact credentials and sensitive
URLs in evidence. A 200 response with a login/challenge HTML page is not a passed
API test. Successful search is not proof that authenticated writes work.

FurAffinity and Gelbooru cookie workflows need separate phone-only onboarding
tests. API-key providers are a simpler first prototype, but their direct-network
success still needs measurement.

## 6. Storage and update tests

| Action | Expected result |
| --- | --- |
| Download a file, restart, enable airplane mode | Local metadata and explicitly downloaded file remain usable |
| View a remote-only post offline | Honest unavailable state; no claim that it was downloaded |
| Fill available space during a download | Useful storage error; no corrupted final file or false completion |
| Interrupt database write/migration | Consistent recovery or explicit restore path |
| Update with same installer/account | Library and settings survive as documented |
| Change signing account or bundle identity in a test installation | Behavior is recorded; release instructions do not assume data portability |
| Refresh expired signing | App recovers without deleting user data where installer supports it |
| Export, remove the test app, reinstall, import | Restores documented data; missing media/secrets are explained |
| Select a Files directory, restart, remove access | Reopen works when permission remains; revocation produces recovery UI |
| Select a cloud-only file | Download/access progress is visible; no infinite scan |
| Clear cache | Downloaded originals and durable metadata remain intact |
| Restore older export into newer schema | Migration is validated or unsupported version is rejected clearly |

Use disposable test data for destructive recovery tests. Do not test reinstall
recovery against the owner's only copy of a library.

## 7. Suspension and performance

Run foreground, locked-screen, app-switch, force-quit, low-power, low-storage,
network-loss, and resumed-app cases. Test cancellation during download and provider
pagination. For supported iOS versions, evaluate native background transfer and
continued-processing APIs separately; measure actual behavior rather than assuming
equivalence with the desktop worker.

Record these measurements for a declared small and large fixture library:

| Measurement | Why it matters |
| --- | --- |
| Cold launch and first usable gallery | Detect excessive database or bridge work before rendering |
| Peak memory during scrolling and video | Detect OS termination risks and large blob/base64 copies |
| Time/bytes for initial and incremental sync | Separate first-run cost from normal refresh |
| Database/original/cache/model disk usage | Make storage policy understandable |
| Download continuation and resume after interruption | Verify the promised lifecycle contract |
| WD14 latency, peak memory, heat, and battery observations | Decide whether mobile inference should ship |
| Query latency at large-library size | Detect loss of indexes or expensive bridge round trips |

Set acceptance thresholds after establishing the baseline on the target phone.
No timing, memory, battery, or capacity result is available from this audit.

## 8. Touch and accessibility checklist

- Open every route listed in the audit; check back navigation and cold restoration.
- Open/close detail views; return to the same item and scroll position.
- Load more and refresh subscriptions; displayed items must not jump or move above
  the reading position.
- Rotate during playback and browsing; safe-area padding must protect controls.
- Open the keyboard in search/settings; fields and submit/cancel controls stay visible.
- Try pinch, pan, double tap, swipe, and vertical scrolling; gestures do not trap
  navigation or accidentally trigger destructive actions.
- Test inline playback, fullscreen, audio, seeking, and sharing with each advertised
  image/video format on the minimum supported OS.
- Use VoiceOver and larger text; controls have names and content remains reachable.
- Verify reduced-motion behavior and permission-denied states.
- Reach every essential action without a hardware keyboard or hover.

Desktop browser emulation and an iOS simulator can supplement these checks. Neither
establishes physical iPhone codec, memory, signing, Keychain, or background behavior.

## 9. Release evidence template

```text
Product mode: server-connected / standalone / hybrid
Source commit and version:
IPA SHA-256 and size:
macOS runner / Xcode / SDK:
Minimum supported iOS:
Phone model and installed iOS:
Installer and version:
Signing account class: free / paid (no identifying credentials)
Server version, if applicable:
Providers/actions validated:
Installation, refresh, update result:
Offline/storage/restore result:
Suspension/force-quit result:
Media formats and touch routes checked:
Known unsupported features:
Unresolved failures:
```

Publish only compatibility claims supported by this record. Keep experimental
features marked experimental until their corresponding gates pass.
