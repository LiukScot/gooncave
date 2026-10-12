# GoonCave for iPhone

This directory owns the iOS distribution: its roadmap, the native project, and
iPhone build and validation documentation.

## Product direction

- The iPhone app is standalone. It runs the shared Rust core on the phone and
  needs no server ([ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md)).
- The shell is Tauri. It shows the shared React interface and calls the Rust
  core directly, with no Swift bridge.
- **iOS 0.2.0:** the Rust core runs on iPhone and keeps its data.
- **iOS 1.0.0:** every row of the [feature inventory](../docs/feature-inventory.md)
  works on iPhone.
- The phone shares its library with the owner's other devices through
  [sync](../docs/sync.md).
- Desktop and iOS release independently ([versioning](../docs/versioning.md)).
  Android has a reserved platform identity, not an approved release target.

## Roadmap and technical references

- [Milestones and issues](roadmap.md)
- [Features the core must cover](../docs/feature-inventory.md)
- [Repository versioning and issue policy](../docs/versioning.md)
- [iOS architecture and feature feasibility audit](../docs/feasibility/ios.md)
- [Build, signing, and GitHub IPA distribution](../docs/feasibility/ios-distribution.md)
- [Physical iPhone acceptance tests](../docs/feasibility/ios-validation.md)

## Build and install

- CI builds an unsigned IPA on hosted macOS. No Mac is needed.
- The owner signs the IPA with KravaSign and installs it.
- App Store submission and AltStore PAL are not release requirements.
- Shell findings on iPhone are recorded in
  [ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md#shell-test-results):
  the app turns on the back and forward edge swipe at startup, and the
  frontend pads the top with `env(safe-area-inset-top)`.

## Code ownership

- iOS-only code and the Tauri iOS project live under `ios/`.
- Shared interface components live in `frontend/`.
- Features live in the Rust core, shared with the desktop app. Do not add
  phone-only copies of core features.
- `backend/` and `tagger/` are reference only. The iPhone app does not run
  them.

## Platform limits

- iOS suspends web view JavaScript in the background. Background work runs in
  the Rust core.
- Background tasks on iPhone are slower and have no GPU. The phone processes
  only the files other devices have not processed, in resumable chunks.
- Folder access and background scheduling need iOS equivalents. If a feature
  cannot work under iOS limits, record the evidence and get an explicit scope
  decision before declaring 1.0.0 complete.
