# GoonCave for iPhone

This directory owns the iOS distribution: its roadmap, native target when
implemented, and platform-specific build and validation documentation.
The native application has not been implemented yet.

## Product direction

- **iOS 0.1.0:** a complete client for the existing GoonCave server.
- **iOS 0.2.0–0.5.0:** add local storage, providers, libraries, and processing.
- **iOS 1.0.0:** recreate the existing feature set in standalone mode.

These are versions of **one app**. Add a server/local toggle as local capabilities
arrive. Keep server mode fully functional throughout the transition. Local mode
must not silently use a server for missing features.

Switching modes does not transfer ownership of data. Server libraries remain on
the server; local libraries remain on the phone. Import, export, or synchronization
requires an explicit workflow with visible consequences.

PC, Android, and iOS release independently. PC 1.0.0 is the packaged server-based
distribution. Android has a reserved platform identity, not an approved release
schedule. The separate browser-only website is no longer planned.

## Roadmap and technical references

- [Milestones, implementation issues, and dependencies](roadmap.md)
- [Repository versioning and issue policy](../docs/versioning.md)
- [iOS architecture and feature feasibility audit](../docs/feasibility/ios.md)
- [Build, signing, and GitHub IPA distribution](../docs/feasibility/ios-distribution.md)
- [Physical iPhone acceptance tests](../docs/feasibility/ios-validation.md)

The release plan selects product behavior, not a framework. Choose the native
shell using working installation, login, authenticated-media, and update evidence.
Reuse the existing React interface and feature contracts where practical.

Build iPhone artifacts on hosted macOS so the maintainer does not need to own a
Mac. Distribute IPAs through GitHub for user re-signing with tested sideloading
tools. App Store submission and AltStore PAL are not release requirements.

## Code ownership

Place the eventual native project and iOS-only integration code under `ios/`.
Keep shared frontend components in `frontend/`. Keep the existing server in
`backend/`; local implementations must not turn its entrypoints into iOS runtime
dependencies. Extract shared domain logic only where an implemented feature
demonstrates the need.

Do not copy the complete server into this directory or fork the React interface
for each mode. Native storage, networking, credentials, files, and job execution
need explicit implementations behind the feature contracts they serve.

## Parity boundary

The roadmap was prepared against repository commit
`49a73f0ab2be13a3ff10fdae61bd45c86d36132c`. The first implementation issue records
a complete baseline inventory; the final parity issue verifies every row.
Future PC additions must be reconciled explicitly rather than silently expanding
or shrinking the iOS release.

Include Gallery, Explore, all nine provider engines and supported actions,
favorites, subscriptions, pools/relations, read state, blacklist, settings,
local profiles, imported files, taxonomy/search, source matching, duplicates,
and WD14. The current Games screen is a placeholder, not an implemented game.

Folder access and background scheduling need iOS equivalents. If a feature cannot
be reproduced under platform constraints, record the evidence and obtain an
explicit scope decision before declaring 1.0.0 complete.
