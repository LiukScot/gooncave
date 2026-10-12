# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

One React interface serves every distribution: the browser, the packaged desktop app, and the phone apps, which wrap it in a native shell. The design language stays the web one; the user chooses its style (see Capabilities).

## Users

People who collect art they favourite on booru sites (e621, Danbooru, Gelbooru, FurAffinity and others) and keep it on their own device. They browse it on a desktop and on a phone. Today the library lives on a self-hosted server, reached over a home network or a private network like Tailscale; the product is moving to apps that hold the library on the device itself (see Operating Context).

Open: the user confirmed this picture "mostly". Other audiences or corrections were not named yet.

## Product Purpose

GoonCave pulls a person's favourites from every booru onto their own disk and gives them one gallery, one search and one tag vocabulary. Success is never having to visit each site to find something they saved.

## Positioning

- Local-first: the files live on the user's device, not in a hosted service. The direction is to need no server at all ([ADR 0003](adr/0003-local-first-without-server.md)).
- Favourites sync both ways with each booru account.
- One tag database across sites: aliases (`1girls`, `female`) find the same files, broad tags find everything under them, and uncategorised tags get filed.
- Explore searches the configured boorus from the same interface as the local library.

## Operating Context

- Today: self-hosted with Docker on a home machine or server; developed with Bun (backend: Fastify, SQLite; frontend: React, Vite). Auto-tagging runs in a separate Python service with an ONNX model.
- Direction: local apps with no server. Targets are a desktop app (Linux AppImage and Windows .exe), the iPhone app (IPA) and an Android app (APK). Server mode stays fully working until the local apps reach feature parity.
- Used in long browsing sessions: scrolling a grid, opening a picture, swiping or stepping to the next one, going fullscreen.
- Remote boorus rate-limit requests, so the app caches previews and paces its calls.

## Capabilities and Constraints

- Library: local files with booru-style gallery, duplicate checks, WD14 auto-tagging, parent/child posts, pools.
- Sync: booru sites with dual-way favourites, tag fetch and source matching, SauceNAO/Fluffle source finder, followed artists feed.
- Search: booru syntax (`a b`, `~a ~b`, `-a`, `score:>5`), autocomplete from the user's own tags, tag blacklist.
- Controls: remappable keyboard shortcuts, fullscreen with wheel zoom and pan.
- Appearance, chosen per device: light, dark or system mode; an accent colour; and one of three styles (Material Edition, Apple Edition, Custom). An open picture lends its colour to the accent. How the styles differ: [docs/styles.md](docs/styles.md).
- The content is adult art. The app does not moderate or rate it beyond what each booru provides.
- PC, iOS and Android release independently ([versioning](docs/versioning.md)). Android still needs the owner's approval before a release target exists.
- Accounts: today one server holds several accounts, each with its own library. Account creation is being dropped with the server; what replaces it on a local device is undecided.

## Brand Commitments

- Name: GoonCave.
- Voice: cheeky and playful. Jokes and personality belong in empty states, loaders and messages, not only in easter eggs. Labels on controls still name their action plainly.

## Evidence on Hand

- Feature list and setup: `README.md`.
- Direction away from the server: `adr/0003-local-first-without-server.md`.
- iOS direction: `ios/README.md`, `ios/roadmap.md`.
- No screenshots, testimonials, user counts or press exist in the repository. Do not invent them.

## Product Principles

1. The art comes first: the picture gets the space and the attention, and the interface steps back around it.
2. Keep booru conventions: tag syntax, category colours and the artist → character → species → general → meta order are what users already know.
3. The user owns their library: nothing leaves their device unless they connect a booru account to sync it.
4. Playful in words, plain in controls: personality lives in copy, never at the cost of knowing what a button does.
