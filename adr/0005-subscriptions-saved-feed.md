# ADR 0005: Subscriptions as a Saved Feed Synced in the Background

## Status

Accepted on 2026-11-19. Replaces the live feed of #714.

## Date

2026-11-19

## Context

1. #526 (2026-10-13) saved the feed: a refresh read new posts into SQLite and
   the feed listed them.
2. #702 (2026-11-16) set the refresh to the newest page (40 posts) of each
   search, at most 24 requests per site, then 3 older pages.
3. On a refresh, older posts appeared inside earlier days (#710): posts past
   the first 40 of a search, and searches past the 24 requests, were reached
   later by backfill.
4. #714 removed the saved feed: each feed page asked every search of every
   site live. Its PR recorded the cost: the first page needs many requests
   with many Danbooru or Gelbooru searches.
5. Measured on the owner's library (359 searches on e621, Danbooru, Rule34
   and FurAffinity): the first page took 108 s, 68 s of it for 181 Danbooru
   requests (two tags per query). With Unread only, posts already read had to
   be downloaded again to be skipped, so a load showed one post or none. A
   five-minute cache of the site pages helped only a reopening within five
   minutes.

## Decision

- **Saved feed.** A sync reads each search newest first until it reaches
  the newest post it saved before, with no cap of posts or requests per
  search. It runs every 15 minutes and when the feed opens.
- **Opening asks no site.** The feed lists the saved posts by date. Unread
  only is a database filter.
- **Older posts are read when the reader reaches them.** A search that may
  have older posts limits the list to its oldest saved date until it reads
  further, so a post found later never lands among posts already shown.
- **New posts wait above.** Posts the sync finds while the feed is open are
  not inserted above the reader; a label at the top says how many and
  reloads.
- **Danbooru** searches only the tags that have posts or are aliases there;
  the lookup is kept a day.
- **Device only.** The saved feed is not synced and not in backups.

## Consequences

- The first opening after installing or changing subscriptions reads one
  page per search (16 s measured on the owner's library).
- The database grows by about 8 MB a month on the owner's subscriptions
  (about 58 posts a day, about 4 KB each). Posts older than 365 days are
  deleted.
- Saved posts can be read offline.

## Rejected alternatives

- **Live feed (#714):** slow on every opening and with Unread only; see
  Context.
- **Saved feed ordered by discovery time (#710):** moves late posts to the
  top instead of reading them in time.
- **Caching the live feed's site pages:** helps only a reopening within the
  cache time.

## Before changing this

Going back to a live feed brings back the slow openings. Capping the sync
per search or per site brings back older posts inside earlier days.
