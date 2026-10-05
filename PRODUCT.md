# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The iPhone app (`ios/`) reuses the React interface inside a native shell, so the design language stays the web one.

## Users

People who collect art they favourite on booru sites (e621, Danbooru, Gelbooru, FurAffinity and others) and keep it on their own server. They browse it on a desktop and on a phone, over their home network or a private network like Tailscale. One server can hold several accounts, each with its own library.

Open: the user confirmed this picture "mostly". Other audiences or corrections were not named yet.

## Product Purpose

GoonCave pulls a person's favourites from every booru onto their own disk and gives them one gallery, one search and one tag vocabulary. Success is never having to visit each site to find something they saved.

## Positioning

- Local-first: the files live on the user's disk, not in a hosted service.
- Favourites sync both ways with each booru account.
- One tag database across sites: aliases (`1girls`, `female`) find the same files, broad tags find everything under them, and uncategorised tags get filed.
- Explore searches the configured boorus from the same interface as the local library.

## Operating Context

- Self-hosted with Docker on a home machine or server; developed with Bun (backend: Fastify, SQLite; frontend: React, Vite).
- Used in long browsing sessions: scrolling a grid, opening a picture, swiping or stepping to the next one, going fullscreen.
- Remote boorus rate-limit requests, so the app caches previews and paces its calls.

## Capabilities and Constraints

- Library: local files with booru-style gallery, duplicate checks, WD14 auto-tagging, parent/child posts, pools.
- Sync: per-account booru sites, dual-way favourites, tag fetch and source matching, SauceNAO/Fluffle source finder, followed artists feed.
- Search: booru syntax (`a b`, `~a ~b`, `-a`, `score:>5`), autocomplete from the user's own tags, tag blacklist.
- Controls: remappable keyboard shortcuts, fullscreen with wheel zoom and pan.
- The content is adult art. The app does not moderate or rate it beyond what each booru provides.
- PC, iOS and Android release independently; iOS 0.1.0 is a full client for the server, iOS 1.0.0 a standalone app with the server mode kept.

## Brand Commitments

- Name: GoonCave.
- Voice: cheeky and playful. Jokes and personality belong in empty states, loaders and messages, not only in easter eggs. Labels on controls still name their action plainly.

## Evidence on Hand

- Feature list and setup: `README.md`.
- iOS direction: `ios/README.md`, `ios/roadmap.md`.
- No screenshots, testimonials, user counts or press exist in the repository. Do not invent them.

## Product Principles

1. The art comes first: the picture gets the space and the attention, and the interface steps back around it.
2. Keep booru conventions: tag syntax, category colours and the artist → character → species → general → meta order are what users already know.
3. The user owns their library: nothing leaves their server unless they connect an account to sync it.
4. Playful in words, plain in controls: personality lives in copy, never at the cost of knowing what a button does.
