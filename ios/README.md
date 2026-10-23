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
  the app turns on the back and forward edge swipe at startup, and the
  frontend pads the top with `env(safe-area-inset-top)`.

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
- Extra → "Delete from Photos after adding" makes the button open the photo
  picker of `PhotoLibrary/` instead. After adding, iOS asks the person to
  confirm and deletes the originals; they stay in Recently Deleted for 30 days.
  The option asks for access to the photo library the first time.
- `PhotoLibrary/PhotoLibrary.swift` is built by `scripts/build-unsigned-ipa.sh` into
  `Frameworks/libGoonCavePhotos.dylib`, which the app loads at startup
  (`src-tauri/src/photos.rs`). Without it, the option is hidden.

## Platform limits

- iOS does not let an app start other programs, so the core cannot run
  FFmpeg there. The app decodes pictures with ImageIO and videos with
  AVFoundation for thumbnails, sizes and duplicate hashes. GIF tiles in the
  Gallery are still pictures on iPhone. AVFoundation does not read WebM, MKV,
  AVI, WMV or FLV, so those videos have no thumbnail or size on iPhone.
- The iPhone web view drops the page's downloads, so exporting a backup saves
  no file yet. Where downloads go on iPhone, the Files app or the share sheet,
  is still to be decided.
- iOS suspends web view JavaScript in the background. Background work runs in
  the Rust core.
- Background tasks on iPhone are slower and have no GPU. The phone processes
  only the files other devices have not processed, in resumable chunks.
- Folder access and background scheduling need iOS equivalents. If a feature
  cannot work under iOS limits, record the evidence and get an explicit scope
  decision before declaring standalone parity complete.
