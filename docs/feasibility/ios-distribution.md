# iOS build and sideload distribution without owning a Mac

Status: proposed delivery guide, researched 2026-09-26. No IPA was built or
published. Read the [architecture audit](ios.md) before choosing what to package.

## 1. Build, sign, install, and host are different operations

| Operation | Meaning | Where it happens in the proposed route |
| --- | --- | --- |
| Build | Compile an iPhone application and bundle its assets | GitHub-hosted macOS with Xcode |
| Package | Put the device `.app` into an IPA archive | Same build job |
| Sign/provision | Authorize the app for a signing identity and eligible device | User's sideloading tool/account |
| Install | Transfer/register the signed app on the phone | AltStore Classic, SideStore, or another tested installer |
| Host | Make the downloadable artifact and metadata available | GitHub Releases, optionally a static source feed |
| Refresh | Renew the installed app's signing validity | User's installer; not a new GoonCave release |
| Update | Replace installed application code with a new version | Download new IPA and sign/install it |

An IPA is an archive containing a compiled application, not a web build renamed.
An unsigned or ad-hoc-signed artifact for re-signing cannot run on stock iOS by
itself. Here “ad-hoc-signed” can also mean a local code signature with no trusted
identity; that is different from **Apple Ad Hoc distribution**, which uses a
paid team's profile and registered devices.

## 2. Viable build routes

| Route | Own Mac required | Fit | Limit |
| --- | --- | --- | --- |
| GitHub Actions macOS runner | No | Recommended for repeatable IPA builds from this repository | CI logs replace much interactive debugging; no physical access to owner's iPhone |
| Rented/remote Mac | No | Useful when Xcode interaction or native diagnostics are needed | Paid service and remote-device access arrangements |
| Managed cloud mobile CI | No | Can simplify signing and build management | Confirm unsigned artifact support, stack compatibility, costs, and account requirements |
| A contributor's Mac | No | Useful for initial scaffolding/device diagnosis | Reproduce the build in CI to avoid depending on one contributor |
| Linux-only normal Xcode build | No | Not supported | Linux cannot run the supported Xcode/iOS SDK build pipeline |
| Unofficial SDK/cross-compilation toolchains | No | Experimental niche | SDK acquisition/licensing, plugin compatibility, signing, and debugging make this a poor baseline |
| iPhone alone as a normal Xcode build machine | No | Not supported by the proposed stack | A browser can trigger cloud CI but does not replace its Mac |

Capacitor 8 documentation currently requires Node 22+ and Xcode 26+; the iOS
runtime documents iOS 15+ support. Individual plugins or chosen features can raise
that deployment minimum. Use matching Capacitor packages and verify the generated
project. Prefer its documented Swift Package Manager path unless a required
plugin needs CocoaPods. Sources: [environment](https://capacitorjs.com/docs/getting-started/environment-setup),
[iOS support](https://capacitorjs.com/docs/ios).

GitHub documents standard hosted runners as free for public repositories. Private
repositories use included minutes and then billing; larger runners and artifact
storage have separate rules. Pin a supported macOS image and select/check the
installed Xcode version rather than relying blindly on `macos-latest`.
See [GitHub runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## 3. Recommended unsigned-artifact pipeline

This is a design specification, not a workflow that can run on the current repo.
The repository has no iOS target yet. Do not add a publish job before a tested app
exists.

1. Create the chosen native target and commit its project configuration.
2. Keep bundle identifier, display name, deployment target, icons, and permissions
   explicit. Start with one app target and no optional extensions.
3. Run existing applicable frontend/backend checks on Linux.
4. On macOS, check out the exact tested commit and record Xcode/SDK versions.
5. Install locked frontend dependencies and build its production assets.
6. For a bundled app, synchronize those assets into the iOS project.
7. Resolve locked native dependencies and build **for an iOS device**.
8. Package the resulting `.app` under `Payload/` in the IPA.
9. Inspect the bundle, binaries, deployment target, entitlements, and assets.
10. Upload a CI artifact for physical-device validation.
11. After install/update tests pass, publish an approved GitHub Release with the
    IPA, checksum, source revision, and installation notes.
12. Update any installer source feed only after the asset is available and tested.

The iOS simulator is a different build platform. An ARM64 simulator build is
still not an iPhone build, even though both use ARM64 instructions.

Illustrative macOS command, **not executed or verified for GoonCave**:

```text
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath build/ios \
  CODE_SIGNING_ALLOWED=NO \
  build
```

The project path/scheme must come from the generated target. A CocoaPods setup
normally uses its workspace instead. Native frameworks and build scripts can
introduce extra requirements. Do not claim that the example builds an IPA on its
own; it only illustrates the intended device compilation without publisher
signing. Validate the actual unsigned app with the intended re-signing tool.

Expected package shape:

```text
GoonCave-<version>-ios.ipa
└── Payload/
    └── App.app/
        ├── Info.plist
        ├── App                  # actual CFBundleExecutable value
        ├── Frameworks/           # if the target needs embedded frameworks
        └── ...bundled assets...
```

Package the entire app bundle while preserving file attributes. Do not remove
frameworks, resources, or required privacy manifests to make the archive smaller.
Do not apply a profile from an unrelated sample application.

### Why publisher credentials are unnecessary for this route

The build artifact is intended for user re-signing. A simple unsigned target can
be compiled without the maintainer uploading an Apple account password,
certificate, or provisioning profile to GitHub. The installer supplies the
user-specific signature/profile later. Restricted capabilities can invalidate
that assumption, which is why the first target should be minimal.

If a future route uses publisher-signed Ad Hoc builds, use protected CI secrets
and register eligible devices through Apple's process. Never bake credentials,
pairing records, provider cookies, user databases, or personal certificates into
the downloadable artifact.

### Release workflow boundaries

Use `contents: read` by default and grant release-write permission only to the
publication job. Pin third-party actions to reviewed commit SHAs. Build untrusted
pull requests without publishing credentials. Keep the existing Docker workflow
separate from the new artifact route.

Initially prefer a manual build and explicit release approval. A later tag-based
release workflow is reasonable once publishing automation is deliberately enabled.
An audit request does not enable that automation.

## 4. Installation and distribution comparison

| Route | What users need | Expiry / constraints | Suitable for public GitHub IPA? |
| --- | --- | --- | --- |
| AltStore Classic | Apple account, AltStore, AltServer on supported Mac/Windows setup | Free signing normally expires in 7 days; 3 active sideloaded apps; refresh access needed | Yes |
| SideStore | Initial computer setup including Linux, Apple account, pairing, local VPN and Wi-Fi | Free signing still expires; refresh on device after setup; pairing can need repair | Yes; preferred documented Linux route to test |
| Sideloadly | Windows or macOS computer and Apple account | Free signing 7 days; paid account can extend validity; computer refresh workflow | Yes |
| Apple Ad Hoc | Paid developer membership, registered device IDs, matching profile | Limited registered test-device pool and profile validity | Restricted tester cohort, not arbitrary public installation |
| TestFlight | Apple's beta distribution infrastructure | Review/beta lifecycle and expiration | Does not meet the desired GitHub-IPA route |
| AltStore PAL / official alternative marketplace | Eligible region/device and notarized distribution package | Apple program, notarization, and marketplace requirements | Not by importing an arbitrary `.ipa` |
| Apple Web Distribution | Apple's eligibility approval, registered domain, notarized packages | Regional/program restrictions | Not equivalent to uploading a release asset |
| Enterprise distribution | Eligible organization distributing internally | Employee/internal-use scope | Not a public-user distribution route |
| Third-party certificate signing services | Service-specific certificate/profile/device registration | Trust, cost, revocation, and eligibility vary | Technically some can sign the IPA; no provider endorsed or verified here |
| TrollStore | Exact supported device OS / installation conditions | Exploit-dependent compatibility | Optional niche compatibility, not the baseline |
| Jailbroken-device tools | Jailbroken device and compatible tools | Device/OS-specific; outside normal sandbox assumptions | Separate unsupported audience unless explicitly adopted |

Installer sources: [AltServer](https://faq.altstore.io/altstore-classic/altserver),
[Classic limits](https://faq.altstore.io/altstore-classic/your-altstore),
[SideStore setup](https://docs.sidestore.io/docs/installation/prerequisites),
[Sideloadly](https://sideloadly.io/).

The active-app limit is not the same as the App ID limit. Extensions consume
additional App IDs; the installer itself normally occupies an active app slot.
Keep an extension-free baseline and document the measured slot use.
See [AltStore App IDs](https://faq.altstore.io/altstore-classic/app-ids).

Apple currently lists Developer Program membership at USD 99/year or local
currency. Free Personal Team provisioning expires after seven days. Paying for
membership is not required just to generate an unsigned artifact, and it does
not give every downloader permanent installation rights. See
[Apple memberships](https://developer.apple.com/support/compare-memberships/).

### AltStore Classic versus PAL

They are different distribution systems. Classic signs ordinary IPAs using the
user's development identity. PAL distributes notarized apps through an official
alternative marketplace. PAL's developer process uses an Alternative Distribution
Package, not the same unsigned IPA/source feed used by Classic.
See [PAL distribution](https://faq.altstore.io/developers/distribute-with-altstore-pal)
and [PAL app guidelines](https://faq.altstore.io/developers/app-guidelines).

Avoid App Store assumptions in either direction: skipping App Store publication
does not disable the iOS sandbox or signing, and PAL notarization is not identical
to full App Store review. Content/platform eligibility must be checked for any
marketplace route actually selected; no acceptance conclusion is made here.

Apple's EU Web Distribution has its own current eligibility options, approved
domain requirements, and notarization process. It should not be described using
only the older “two years and one million installs” condition; the current page
lists additional eligibility paths. It is still a different project from GitHub
IPA hosting. See [Apple Web Distribution](https://developer.apple.com/support/web-distribution-eu/).

### TrollStore is not a solution for an unspecified iPhone

The upstream README lists iOS 14.0 beta 2–16.6.1, 16.7 RC (20H18), and 17.0.
Do not interpret that as general support for iOS 17.x or current iOS releases.
Do not lower the application's security baseline or require privileged entitlements
for this installer. See [TrollStore upstream](https://github.com/opa334/TrollStore).

## 5. What the owner can do without a Mac

### Linux computer available

Recommended installation candidate: SideStore using its documented Linux setup.
The guide currently provides iloader packages including RPM and AppImage, and
requires USB device access through `usbmuxd`. Follow the current official guide
rather than old instructions for a different VPN or pairing tool.

Once set up, fetch the released IPA on the iPhone and install/refresh through
SideStore with its required network/VPN configuration. An iOS update or pairing
failure can require computer access again. Pairing records are sensitive and
must stay out of GitHub. See [pairing-file recovery](https://docs.sidestore.io/docs/advanced/pairing-file).

Community Linux AltServer implementations exist, but this report has not validated
one. Prefer the documented SideStore route before building support instructions
around an unofficial replacement for AltServer.

### Windows computer available

AltStore Classic or Sideloadly is a direct option. SideStore is another option
when on-phone refreshes are preferable. Follow the selected tool's Apple driver
and setup instructions; the tools' requirements are not interchangeable.

### Literally only an iPhone, with no computer access

The build can still run in GitHub Actions and be triggered from a browser. Initial
Classic/SideStore installation remains unresolved unless a compatible installer
is already present or a computer can be borrowed. A preconfigured signing service
is a separate trust/cost decision, not a universally reliable free workaround.
PAL does not solve arbitrary IPA installation. Safari/Home Screen access to a
server remains the practical no-sideloading fallback.

Record the actual phone version and existing installer before prescribing exact
device steps. Developer Mode and certificate trust prompts depend on installation
method and OS. Follow the installer's current instructions and Apple's
[Developer Mode guide](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

## 6. GitHub release contents

Suggested release contract:

| Asset / metadata | Purpose |
| --- | --- |
| `GoonCave-<version>-ios.ipa` | Device application for user re-signing |
| SHA-256 checksum file | Detect accidental/tampered download mismatch before signing |
| Tagged source and exact commit SHA | Associate binary with reviewable source |
| Toolchain/version record | Reproduce the build configuration |
| Minimum iOS and tested device/installer versions | Avoid promising untested compatibility |
| Supported server API version, if applicable | Diagnose client/server mismatch |
| Installation, refresh, update, recovery instructions | Explain that download alone does not install |
| Permission list and data-storage explanation | Show what the app accesses and where data lives |
| Migration and export notes | Prevent data loss during upgrades or signing changes |

Use GitHub Releases for downloadable versions. CI artifacts are temporary test
outputs with retention/access behavior, not the public installer update channel.
GitHub Pages can host static source metadata; it cannot run the current Bun API,
worker, or Python tagger.

Keep published version URLs immutable. An installer refresh renews signing of
installed code; it should not be confused with fetching a new application version.
The app may show an update link, but cannot silently replace its own signed binary
like a desktop updater. Do not use downloaded JavaScript as a way to hide
unversioned native/API compatibility changes.

### Optional AltStore Classic source

A source is a publicly accessible JSON catalog describing apps and versions.
It makes releases discoverable and updatable within compatible installers; it
does not remove signing expiry. Use the current **Classic** example/schema,
not the PAL one. Include accurate bundle identifiers, version/build metadata,
minimum OS, direct IPA URL, size, icons, description, and required permissions.

Generate metadata from the built artifact where possible. Keep every declared
entitlement and privacy permission consistent with the IPA. Test an actual import
and update in each supported installer before advertising source compatibility.
Host the source at a stable HTTPS address and point versions at immutable release
assets. See [AltStore source specification](https://faq.altstore.io/developers/make-a-source).

No source JSON is included here because there is no verified IPA, bundle ID,
minimum OS, asset size, permission set, or release URL to populate it accurately.

### Licenses and private content

The repository root [LICENSE](../../LICENSE) contains GPLv3, while
`backend/package.json` declares MIT. Record and resolve that metadata discrepancy
before publishing a binary; do not infer a license change. Publish the corresponding
source/build information and applicable notices for the components actually
distributed. Native libraries and model weights need their own license review.

Do not include user libraries, provider credentials, search history, private server
addresses, or downloaded third-party media in release assets or screenshots.
This release should contain application code/resources, not the maintainer's data.

## 7. Recovery instructions the release must provide

| Symptom | Check first | Recovery direction |
| --- | --- | --- |
| IPA downloads but does not install | Was it imported through a supported signer? | Explain re-sign/install; Safari is not an IPA installer |
| App stops launching after several days | Signing/profile expiration | Refresh/re-sign through the installer before considering deletion |
| “Maximum apps” / App ID errors | Active app slots and extensions | Use installer guidance; avoid creating new bundle IDs on each retry |
| Works in simulator, fails on phone | Device build platform, deployment minimum, signing | Inspect binary/platform and installation logs |
| Login succeeds, next request is 401 | Cookie/transport mismatch | Test API and media cookie stores; do not ask users to disable security |
| Blank screen or connection failure | Server URL, network permission, TLS, server availability | Show native recovery/setup UI |
| API works, images/videos fail | Media auth, redirects, ranges, codec | Diagnose the resource path separately |
| Updated app appears empty | Account/server/profile/bundle identity changed | Inspect identity and restore export; preserve old installation if possible |
| Background sync incomplete | App suspension/termination or task expiry | Resume persisted queue and show completed/remaining work |
| SideStore cannot refresh | VPN/Wi-Fi, expiry, pairing validity | Follow current pairing/install recovery guide |

Installation and update evidence required before release is listed in
[the validation plan](ios-validation.md).
