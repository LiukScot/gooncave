# GoonCave for iPhone

This directory owns the iOS distribution: its roadmap, the native project, and
iPhone build and validation documentation.

## Product direction

- The iPhone app is standalone. It runs the shared Rust core on the phone and
  needs no server ([ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md)).
- The shell is Tauri. It shows the shared React interface and calls the Rust
  core directly, with no Swift bridge.
- **Rust core on iPhone:** the Rust core runs on iPhone and keeps its data.
- **Standalone parity:** every row of the [feature inventory](../docs/feature-inventory.md)
  works on iPhone.
- The phone shares its library with the owner's other devices through
  [sync](../docs/sync.md).
- Desktop and iOS share one release version ([versioning](../docs/versioning.md)).
  Android has a reserved platform identity, not an approved release target.

## Roadmap and technical references

- [Milestones and issues](roadmap.md)
- [Features the core must cover](../docs/feature-inventory.md)
- [Repository versioning and issue policy](../docs/versioning.md)
- [iOS architecture and feature feasibility audit](../docs/feasibility/ios.md)
- [Build, signing, and GitHub IPA distribution](../docs/feasibility/ios-distribution.md)
- [Physical iPhone acceptance tests](../docs/feasibility/ios-validation.md)

## Build and install

- CI builds an unsigned IPA on hosted macOS for every pull request that
  changes the core, the frontend or `ios/`. No Mac is needed. Download the
  `gooncave-iphone` artifact from the `iPhone app / Build the IPA` check, or
  the `.ipa` attached to a release.
- The owner signs the IPA with KravaSign and installs it.
- To build on a Mac with Xcode, Rust, Node.js and `xcodegen`: from `ios/`, run
  `npm ci`, `npm run tauri -- ios init`, then
  `bash scripts/build-unsigned-ipa.sh GoonCave.ipa`.
- App Store submission and AltStore PAL are not release requirements.
- Shell findings on iPhone are recorded in
  [ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md#shell-test-results):
  the frontend pads the top with `env(safe-area-inset-top)`. The back edge
  swipe is the frontend's own (`frontend/src/lib/edgeSwipeBack.ts`), so the
  page it returns to shows underneath; the native one is off.

## Code ownership

- iOS-only code and the Tauri iOS project live under `ios/`. The app starts
  the core on its saved loopback port and shows the interface the core serves,
  as the Linux shell does; `ios/ui` holds only the page shown while the library
  opens and when it cannot open. The library opens off the launch path: iOS
  ends an app whose launch blocks too long.
- Shared interface components live in `frontend/`.
- Features live in the Rust core, shared with the desktop app. Do not add
  phone-only copies of core features.

## Share sheet

- GoonCave appears in the share sheet for pictures, videos and files. The share
  extension (`ShareExtension/`) copies them into a folder shared with the app
  through the app group `group.app.gooncave.ios`; the app adds them to the library
  when it opens or returns to the foreground.
- The extension is built by `scripts/build-unsigned-ipa.sh` and embedded in the
  IPA unsigned. The re-signing must give both the app and the extension
  (`<bundle id>.share`) the app group. Without it the extension tells the person
  that GoonCave cannot receive files, and nothing is added.

## Adding files from the gallery

- The gallery's "Add files" button opens the iOS picker, which offers Photos and
  Files, and adds what the person picks. It needs no app group.
- A file whose name the library already has is added with a number, as
  `Video (2).mov`.
- Extra → "Delete from Photos after adding" makes the button open the photo
  picker of `PhotoLibrary/` instead. After adding, iOS asks the person to
  confirm and deletes the originals; they stay in Recently Deleted for 30 days.
  The option asks for access to the photo library the first time.
- `PhotoLibrary/PhotoLibrary.swift` is built by `scripts/build-unsigned-ipa.sh` into
  `Frameworks/libGoonCavePhotos.dylib`, which the app loads at startup
  (`src-tauri/src/photos.rs`). Without it, the option is hidden.

## Sharing from the detail view

**Sources → Share file** and Explore's post link share present the system
activity panel. On iPhone with iOS 26, presenting it directly from GoonCave's
Tauri view controller could leave it narrow and clipped against the right
edge. A wider anchored variant could close on the first touch, leaving its
lower actions unreachable.

These comparisons used the same file on a physical iPhone:

| Presentation | Observed result |
| --- | --- |
| UIKit presented directly from Tauri, with the default style or `.pageSheet` | The panel was clipped. One run measured 146 pt wide in a 393 pt window. |
| UIKit popover anchored to the hidden WebKit worker | The panel could fill 375 pt of that window, but later builds with this anchor still closed on touch. |
| Web Share API from the visible web view | The panel was clipped on the right as in the direct UIKit path. |
| UIKit presented from a plain, full-screen `UIViewController` in the same window | The panel opened whole and could be scrolled. |

The [Swift bridge](PhotoLibrary/PhotoLibrary.swift) therefore presents a
full-screen UIKit host for every iPhone share, files and links. Once the host
is visible, it presents `UIActivityViewController` with the default iPhone
style. The host displays a non-interactive snapshot of the screen it covers,
so Sources or the post stays visible behind the panel. When sharing finishes
or is cancelled, the host dismisses before the result goes back to Rust. iPad
uses an anchored popover. Apple documents [modal presentation on iPhone and
popover presentation on
iPad](https://developer.apple.com/documentation/uikit/uiactivityviewcontroller).

After changing the iOS window, the share bridge, or the presentation sequence,
check on a physical iPhone running iOS 26:

1. Open an image in Gallery and choose **Sources → Share file**. One tap
   opens the panel, with Sources still visible behind it and the right edge
   inside the window.
2. Swipe upward inside the panel. It stays open and the actions at the bottom
   become reachable.
3. Dismiss the panel and share the same image again. Sources is still
   interactive and the second opening works the same way.
4. Open a post in Explore and share its link. The panel opens whole, like
   the file panel.

If the panel clips again, close it and copy the `Share sheet placement` line
from **Settings → Report issue**. It records the presenting controller and
the panel and window frames in points. A full-width frame alone does not
verify that taps and scrolling work.

## Platform limits

- iOS does not let an app start other programs, so the core cannot run
  FFmpeg there. The app decodes pictures with ImageIO and videos with
  AVFoundation for thumbnails, sizes and duplicate hashes. GIF tiles play
  a muted H.264 preview near the viewport and keep a still poster for reduced
  motion. AVFoundation does not read WebM, MKV,
  AVI, WMV or FLV, so those videos have no thumbnail or size on iPhone.
- The iPhone web view drops the page's downloads, so exporting a backup saves
  no file yet. Where downloads go on iPhone, the Files app or the share sheet,
  is still to be decided.
- WebKit keeps a page's animations near 60 fps even on a 120 Hz iPhone. The
  app turns that off with a private WebKit preference
  (`PreferPageRenderingUpdatesNear60FPSEnabled`, in `src-tauri/src/lib.rs`)
  and declares `CADisableMinimumFrameDurationOnPhone` in `Info.ios.plist`.
  The App Store rejects private preferences. If a future iOS drops this one,
  the log says so and animations go back to 60 fps.
- iOS suspends web view JavaScript in the background. Background work runs in
  the Rust core.
- Background tasks on iPhone are slower and have no GPU. The phone processes
  only the files other devices have not processed, in resumable chunks.
- Folder access and background scheduling need iOS equivalents. If a feature
  cannot work under iOS limits, record the evidence and get an explicit scope
  decision before declaring standalone parity complete.
