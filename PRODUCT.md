# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

One React interface serves every platform: the desktop app and the iPhone app, both in a Tauri shell. The design language stays the web one; the user chooses its style (see Capabilities).

## Users

People who collect art they favourite on booru sites (e621, Danbooru, Gelbooru, FurAffinity and others) and keep it on their own device. They browse it on a desktop and on a phone. Each device holds the library itself; devices share it through a WebDAV folder the owner chooses.

Open: the user confirmed this picture "mostly". Other audiences or corrections were not named yet.

## Product Purpose

GoonCave pulls a person's favourites from every booru onto their own disk and gives them one gallery, one search and one tag vocabulary. Success is never having to visit each site to find something they saved.

## Positioning

- Local-first: the files live on the user's device, not in a hosted service. There is no server ([ADR 0004](adr/0004-flatpak-desktop-and-device-sync.md)).
- Favourites sync both ways with each booru account.
- One tag database across sites: aliases (`1girls`, `female`) find the same files, broad tags find everything under them, and uncategorised tags get filed.
- Explore searches the configured boorus from the same interface as the local library.

## Operating Context

- One Rust core runs on every device and serves the React interface's HTTP API on the device only.
- Platforms: a desktop app (Linux `.flatpak` first, Windows `.exe` later) and the iPhone app (unsigned IPA). An Android app has no approved release target.
- No app is downloadable until the core covers every desktop feature.
- Sync: each app connects to a WebDAV folder, and later to Google Drive ([docs/sync.md](docs/sync.md)). Booru credentials never leave the device.
- Used in long browsing sessions: scrolling a grid, opening a picture, swiping or stepping to the next one, going fullscreen.
- Remote boorus rate-limit requests, so the app caches previews and paces its calls.

## Capabilities and Constraints

- Library: local files with booru-style gallery, duplicate checks, WD14 auto-tagging, parent/child posts, pools.
- Sync: booru sites with dual-way favourites, tag fetch and source matching, SauceNAO/Fluffle source finder, followed artists feed.
- Search: booru syntax (`a b`, `~a ~b`, `-a`, `score:>5`), autocomplete from the user's own tags, tag blacklist.
- Controls: remappable keyboard shortcuts, fullscreen with wheel zoom and pan.
- Appearance, chosen per device: light, dark or system mode; an accent colour; and one of three styles (Material Edition, Apple Edition, Custom). An open picture lends its colour to the accent. How the styles differ: [docs/styles.md](docs/styles.md).
- The content is adult art. The app does not moderate or rate it beyond what each booru provides.
- All supported platforms share one release version ([versioning](docs/versioning.md)). Android still needs the owner's approval before a release target exists.
- Accounts: none. Each device has one owner and no login.

## Brand Commitments

- Name: GoonCave.
- Voice: cheeky and playful. Jokes and personality belong in empty states, loaders and messages, not only in easter eggs. Labels on controls still name their action plainly.

## Evidence on Hand

- Feature list: `README.md`; features the core must cover: `docs/feature-inventory.md`.
- Platforms and sync: `adr/0004-flatpak-desktop-and-device-sync.md`, `docs/sync.md`.
- iOS direction: `ios/README.md`, `ios/roadmap.md`.
- No screenshots, testimonials, user counts or press exist in the repository. Do not invent them.

## Product Principles

1. The art comes first: the picture gets the space and the attention, and the interface steps back around it.
2. Keep booru conventions: tag syntax, category colours and the artist → character → species → general → meta order are what users already know.
3. The user owns their library: nothing leaves their device except to the booru accounts and the sync folder they connect.
4. Playful in words, plain in controls: personality lives in copy, never at the cost of knowing what a button does.
