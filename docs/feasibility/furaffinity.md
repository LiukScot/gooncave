# FurAffinity integration — feasibility report

> **Issue:** [#7](https://github.com/LiukScot/gooncave/issues/7) (closed) — _Verificare possibile implementazione di furaffinity in sync fav, tags, download etc_
>
> **Follow-ups:** engine implementation in [#295](https://github.com/LiukScot/gooncave/issues/295); the artist-vs-tag question this raised for subscriptions in [#293](https://github.com/LiukScot/gooncave/issues/293).
>
> **Status:** ✅ **FEASIBLE** — spike executed 2026-08-30 against a real account. Cloudflare passed, cookies authenticated, favorites, tags, downloads and favorite-state all confirmed. Recommended path: **strategy A** (§5). Coverage is good but partial — see "Coverage" in §3 for what was never exercised.
>
> **Revision note (2026-08):** this report was rewritten against the current engine-registry architecture (`backend/src/lib/booruEngines/`). The original version predated that refactor and referenced code that no longer exists (`dataStore.ts`, `resolveE621Auth`, the `syncProvider()` switch).

## 1. Executive summary

Gooncave integrates external sources through pluggable **booru engines** (8 today: e621, danbooru, gelbooru, moebooru, philomena, sankaku, shimmie, szurubooru). All of them talk to REST/JSON APIs — except gelbooru's favorites path, which already scrapes HTML behind a session cookie. That precedent matters: **an FA engine is "gelbooru's favorites path, but for every method".**

FurAffinity has **no public API**: only HTML pages behind session cookies, with **Cloudflare bot protection** in front. The engine registry makes the _wiring_ cheap (6 mechanical registration points), but five architectural frictions are not wiring problems and need decisions — see §4.3.

This report:

1. Records what the spike measured, including the traps it walked into (§3).
2. Documents the current engine contract and what FA can and cannot fulfil (§4).
3. Covers following artists, which FA does better than any booru here (§4.5).
4. Compares three strategies and settles on one (§5).

## 2. The four blockers

| #   | Blocker                | Severity                                  | Notes                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No public API**      | High — _confirmed, unavoidable_           | All scraping is HTML. No JSON, no MD5 lookup, no batch endpoints. Every method costs a full page fetch (~40–100 KB).                                                                                                                                                                                      |
| 2   | **Cloudflare WAF**     | ~~Unknown~~ → **Resolved, not a blocker** | Plain `undici` + browser-like headers returned HTTP 200 on every request across all four probe phases (~25). No challenge, no `__cf_bm` cookie issued.                                                                                                                                                    |
| 3   | **Cookie-only auth**   | Medium — _confirmed_                      | No API key. Users extract cookies `a` and `b` from their browser and must **not log out** of that session afterwards, or the cookies die.                                                                                                                                                                 |
| 4   | **ToS violation risk** | Medium                                    | FA's ToS forbids automated scraping. Users could in principle get banned. Mitigation: clear in-app warning + conservative rate limit.                                                                                                                                                                     |
| 5   | **Theme fragility**    | Medium — _confirmed relevant_             | FA serves two themes and every scraper is pinned to one. The spike account runs **beta/modern** (`/themes/beta/`), which is what our selectors now target. [faexport](https://github.com/Deer-Spangle/faexport) requires _classic_ — see §5.C. A user switching theme, or FA redesigning, breaks parsing. |

## 3. The spike

Location: [`spikes/furaffinity/`](../../spikes/furaffinity/)

The spike is intentionally **isolated** — its own `package.json`, its own dependencies (`undici`, `cheerio`), not imported by the backend. It can be deleted without breaking anything.

### What it tests

Five scripts, run in this order. The first two answer the original question; the last three were added as that question kept turning out to be too narrow.

- **`probe.ts`**: _"Can plain HTTP requests with session cookies reach FA's authenticated pages, or does Cloudflare block us?"_ Dumps raw HTML to `out/` for inspection.
- **`parse.ts`**: _"Can we parse the structured data we need (favorite ids, thumbnails, keywords, rating, download URL) with stable selectors?"_ Reads the files `probe.ts` saved; makes no requests.
- **`watch.mts`**: _"Can FA back a subscriptions feature?"_ Probes the watchlist, the submission inbox and an artist gallery (§4.5).
- **`capabilities.mts`**: _"Is remote favorite add/remove reachable, and is there anything score-like to sort on?"_ Read-only — it inspects which of `/fav/` or `/unfav/` is rendered, and never follows either.
- **`gaps.mts`**: _"What breaks?"_ Favorites pagination, downloading from the CDN host, the logged-out shape, and a missing submission.

### How to run

See [`spikes/furaffinity/README.md`](../../spikes/furaffinity/README.md). TL;DR:

```bash
cd spikes/furaffinity
npm install
cp cookies.example.json cookies.json   # then edit with real FA cookies
npm run probe
npm run parse

# the later phases are plain scripts, not npm entries
npx tsx watch.mts
npx tsx capabilities.mts
npx tsx gaps.mts
```

`cookies.json` needs a `samplePostId` that is one of **your own** favourites — the fav/unfav state checks depend on it. The account must be on FA's **beta/modern** theme; classic renders different markup and the selectors will miss.

### Empirical results — executed 2026-08-30

Run against a real account on the **beta/modern** theme, across four phases (probe, parse, watch, gaps) totalling roughly 25 requests, always sequential with a 1.5–2 s gap.

The `probe` output below is the corrected run. The original one printed a `session marker … FOUND` line that has since been removed: it was measuring the wrong thing (see trap 4 under "Gap probe").

<details>
<summary><code>npm run probe</code> output</summary>

```
[probe] requesting https://www.furaffinity.net/favorites/<user>/
[probe]   status: 200
[probe]   bytes: 98436
[probe]   server: cloudflare
[probe]   cf-ray: a3322e04...-MXP
[probe]   set-cookie __cf_bm: no
[probe]   body starts with: <!DOCTYPE html> <html lang="en" ... <title>Favorites Gallery for <user> -- Fur Affinity [dot] net</title>
[probe] CLOUDFLARE: PASSED  (HTTP 200, 98474 bytes of HTML)
[probe] requesting https://www.furaffinity.net/view/64670793/
[probe]   status: 200
[probe]   bytes: 68336
[probe]   verdict: PASSED  (HTTP 200, 68336 bytes of HTML)
[probe]   session (fav/unfav token rendered): VALID
```

</details>

<details>
<summary><code>npm run parse</code> output</summary>

```
[parse] extracted 48 favorites
[parse] first 5:
        - id=64670793 title="Heaven☁️" artist="~Peyote"
          thumb=https://t.furaffinity.net/64670793@300-1776200147.jpg
        - id=64111880 title="Hiking Hazards (Alt)" artist="LuxMori"
        - id=41956956 title="Warm, Cozy and Full" artist="theMleme"
        - id=55588796 title="Workout Basics: Stretching" artist="YukiTalLorean"
        - id=59528124 title="Garchomp" artist="MikaeMikae"
[parse] extracted 5 tags from post 64670793
[parse]   category: artwork_digital
[parse]   theme:    all
[parse]   rating:   Adult
[parse]   species:  unspecified_any
[parse]   artist:   _peyote
[parse]   fullview: https://d.furaffinity.net/art/~peyote/1776200147/1776200147.~peyote_heaven_smol.png
[parse]   tags: male, sheath, sweat, hug, pecs
[parse] VERDICT: PARSEABLE ✓
```

</details>

**Cloudflare verdict: PASSED.** Every request across all four phases returned HTTP 200. No interstitial, no `Just a moment...`, no `__cf_bm` cookie set. Plain `undici` with browser-like headers is sufficient — **no headless browser needed**.

**Selectors verdict: PARSEABLE.** 48/48 favorites extracted from page 1 (id, thumbnail, title, artist). Post metadata extracted on 5/5 sampled submissions.

#### Three spike bugs found and fixed during execution

The third is described under "Gap probe" below: the session check tested for the username on a page where the username appears whether or not you are logged in.

1. **`probe.ts` used `undici.request()`**, which does _not_ decompress responses. The saved HTML was raw gzip, so the "are we logged in?" check searched a compressed buffer and reported a **false** `NOT FOUND`. Switched to `undici.fetch()`, which decompresses. Without this fix the spike would have concluded "cookies expired" while the session was perfectly valid.
2. **`parse.ts` targeted a sidebar that does not exist** in the beta theme (`div.submission-sidebar`, `strong` labels), so category/rating/species all read `(not found)`. Replaced with the real source — see below.

#### Key finding: `data-tags` carries all metadata in one attribute

`img#submissionImg` exposes everything except the rating in a single space-separated attribute, with namespace prefixes:

```
u__peyote c_artwork_digital t_all s_unspecified_any male sheath sweat hug pecs
^artist   ^category         ^theme ^species         ^------- keywords -------^
```

The `/search/@keywords` anchors carry the same keywords (matched exactly on 4/5 samples; one post differed in ordering/dedup), but the attribute is the better source: one lookup, no per-anchor iteration. The rating is separate, rendered as a `c-contentRating--<level>` class (§10 — the report first recorded this as `Rating--<level>`, which matches nothing).

#### Keyword density across the 5 sampled submissions

| post     | keywords | category          | species           | rating |
| -------- | -------- | ----------------- | ----------------- | ------ |
| 64670793 | 5        | `artwork_digital` | `unspecified_any` | Adult  |
| 64111880 | 22       | `artwork_digital` | `unspecified_any` | Adult  |
| 41956956 | 16       | `artwork_digital` | `unspecified_any` | Adult  |
| 55588796 | 9        | `all`             | `unspecified_any` | Adult  |
| 59528124 | 17       | `all`             | `unspecified_any` | Adult  |

Average ≈ 14 keywords/post — **denser than expected**, comparable to a modestly-tagged booru post.

**Corrected on a larger sample.** The 5 posts above all showed `s_unspecified_any` and mostly `t_all`, which suggested the prefixed fields were dead weight. That was sampling luck. Re-measured over the 48 submissions on `/msg/submissions/` (§4.5):

| field         | posts with a real (non-default) value |
| ------------- | ------------------------------------- |
| `c_` category | 19 / 47                               |
| `t_` theme    | 16 / 48                               |
| `s_` species  | 15 / 48                               |
| keywords      | 10.2 per post (mean)                  |

So roughly a third of submissions do set category/theme/species — sparse, but real signal (`s_dog_other`, `s_naga`, `t_portraits`). Storing them is defensible; treating them as always-empty is not. The free keywords remain the main payload.

**Rating is available in listings, not just on the post page.** Each `<figure>` carries `class="r-adult t-image"` / `r-general` / `r-mature`, so a listing scrape gets the rating without opening the submission. Distribution on the 48-item sample: 27 adult, 12 mature, 9 general. The `c-contentRating--<level>` class is only needed on the post page itself.

#### Gap probe — the things an engine actually breaks on

Phases 1–3 exercised happy paths. `spikes/furaffinity/gaps.mts` attacks the rest. Four findings, three of them traps:

**1. Favorites paginate by cursor, not page number.** `/favorites/<user>/<favId>/next` — 48 items per page, walked 3 pages for 144 unique submissions, cursors kept coming. Critically, the cursor is a **favourite-relation id** (`1779209458`), not a submission id (`64670793`): the two number spaces are unrelated. So the "stop at last-seen submission id" trick that works for galleries (§4.5) does **not** transfer to favorites sync — that loop pages until it recognises known territory instead.

**2. Downloads need no authentication at all.** The artwork lives on `d.furaffinity.net`, a different hostname from the site. Fetched three ways:

| request               | result              |
| --------------------- | ------------------- |
| no cookie, no referer | HTTP 206, valid PNG |
| cookie only           | HTTP 206, valid PNG |
| cookie + `Referer`    | HTTP 206, valid PNG |

No cookie, no `Referer` (unlike danbooru's CDN). This also makes the cross-hostname guard in `exploreDownloadHeaders` (`services/favorites.ts:420-439`) a non-issue for FA: it would refuse to attach auth to a different host, and none is needed.

**3. A missing submission returns HTTP 200, not 404.** `/view/99999999/` → **HTTP 200**, 877 bytes, _"The submission you are trying to find is not in our database."_ The status code is useless as a signal; detect on the absent `img#submissionImg` plus the tiny body. (`/view/1/` is worse — a 2 MB easter-egg page that _does_ contain a `submissionImg`. Do not probe with low ids.)

**4. Favourites galleries are public, which breaks the obvious session check.** An anonymous request to `/favorites/<user>/` returns HTTP 200 with all 48 figures **and** the string `/user/<username>` — because the username is in the URL. So "is the username in the body?" reports a valid session for a logged-out request.

This was the spike's **third bug**: `detectValidSession()` used exactly that check, on exactly that page. Its earlier `FOUND` proved nothing. Verified the honest signal both ways on a submission page:

| request         | fav/unfav token | username in body |
| --------------- | --------------- | ---------------- |
| with cookies    | present         | present          |
| without cookies | absent          | absent           |

`checkSessionCookie()` must therefore test for the `/fav/` or `/unfav/` link with its `key=` token on a **submission** page. Fixed in the spike; re-run now reports `session (fav/unfav token rendered): VALID`.

A useful corollary: since favourites listings are public, **reading** favorites needs no cookies at all. Only the actions, the watchlist and the inbox do.

#### Coverage — what is and is not verified

Directly answering "did we check everything?": no. Verified, with evidence in this report:

| area                                   | status                                     |
| -------------------------------------- | ------------------------------------------ |
| Cloudflare passage                     | ✅ 20+ requests, all 200                   |
| Favorites read + full pagination       | ✅ cursor walk, 144 items                  |
| Post tags / category / artist / rating | ✅ 5 posts + 48 inbox items                |
| Full-res download                      | ✅ real PNG, no auth                       |
| Favorite-state detection               | ✅ both directions                         |
| Session validity detection             | ✅ both directions, after fixing the check |
| Missing-submission handling            | ✅                                         |
| Watchlist / inbox / artist gallery     | ✅                                         |
| Search sorts and absence of score      | ✅                                         |

**Not verified — carry these into implementation as first tasks:**

| gap                                                       | why it matters                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Executing** a fav/unfav, and the `key` token's lifetime | the only write path; mechanism proven, mutation never run                                                                                                        |
| Rate-limit tolerance                                      | every probe used 1.5–2 s spacing. FA's actual threshold, and what it returns when crossed, are unknown — this decides whether 92-artist polling (§4.5) is viable |
| `/scraps/<artist>/`                                       | artists post there too; polling only `/gallery/` silently misses those submissions                                                                               |
| Gallery folders                                           | an artist's gallery can be subdivided; unclear whether page 1 covers everything                                                                                  |
| URL variants for `extractIdFromUrl`                       | `sfw.furaffinity.net`, bare vs `www`, `/full/` links — Fluffle results may use any of them                                                                       |
| Deep pagination                                           | 3 favorites pages walked; an account with thousands is untested                                                                                                  |
| Logged-out view of mature/adult posts                     | all sampled posts were fetched authenticated                                                                                                                     |
| `probePath` / `probeMatches` for autodetect               | §4.3 friction 2 — never exercised                                                                                                                                |

**All eight were executed on 2026-08-30 — see §9.**

`fetchPostByMd5` is intentionally absent: FA offers no hash lookup. It is optional in the contract (`tagging.ts:198-202` returns empty when missing).

#### Other confirmed capabilities

- **Full-resolution download URL** is in `data-fullview-src` (and a `Download` anchor) on every sampled post — protocol-relative (`//d.furaffinity.net/...`), so it needs an `https:` prefix.
- **Rating** (General/Mature/Adult) is extractable on 5/5.
- **Favorite / unfavorite / state-detection all come from one page fetch.** Verified read-only on two posts (`spikes/furaffinity/capabilities.mts`):

  | post                        | `/fav/` link           | `/unfav/` link         | inferred state |
  | --------------------------- | ---------------------- | ---------------------- | -------------- |
  | 64670793 (in favorites)     | absent                 | present, 64-char token | favorited      |
  | 66088503 (not in favorites) | present, 64-char token | absent                 | not favorited  |

  The two links are **mutually exclusive**, so their direction is an exact state oracle. This is strictly better than gelbooru, which needs a separate `isFavoritedRemotely` re-scrape because its delete redirects without proving removal (issue #144). On FA, remote removal is reachable and its result is verifiable by re-reading the same page.

  ⚠️ **Unverified:** the fav/unfav links were never _followed_ — doing so would mutate a real account. The mechanism and the token are proven present; the mutation itself, and the token's lifetime, still need a first live test during implementation.

- **Artist name quirk:** the `u_` prefix yields `_peyote` for the display name `~Peyote` (FA maps the tilde to an underscore). Strip leading underscores, or prefer the artist anchor, if the artist is stored as a tag.

## 4. What an integration looks like in the current architecture

A source is a `BooruEngineModule` (`backend/src/lib/booruEngines/types.ts`). Registration is 6 mechanical touch points:

1. `backend/src/db/types.ts` — add `'furaffinity'` to the `BooruEngineType` union (the union is lowercase; only preset keys are upper)
2. `backend/src/lib/booruEngines/index.ts` — `ENGINE_REGISTRY` entry + re-export
3. `backend/src/lib/booruEngines/detect.ts` — `HOSTNAME_MAP` entry (`furaffinity.net`)
4. `backend/src/lib/booruEngines/detect.ts` — `PROBE_ORDER` entry
5. `backend/src/routes/booruSites.ts` — the hand-duplicated `engineEnum` Zod literal list (miss this and no site can be created with the engine)
6. `frontend/src/features/booru-sites/shared.ts` — `ENGINE_LABELS` (exhaustive `Record`, frontend build fails until added)

### 4.1 Capability mapping

Capabilities are per-engine flags (`defaultCapabilities`); features silently exclude sites whose engine lacks the capability. FA's honest row in the matrix:

| capability    | FA     | How                                                                                                                                                                                                        |
| ------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `favorites`   | ✓      | Scrape `/favorites/<user>/` pages, paginated — 48 entries per page, `figure[id^="sid-"]`. Same pattern as gelbooru's HTML favorites scrape — which uses `String.matchAll`, not a parser (§10).         |
| `tags`        | ✓      | `fetchPostTags` scrapes `/view/<id>` and reads `data-tags` (§3). ~14 keywords/post on the sample — usable, not the thin result originally assumed. WD14 still adds value but is no longer the only option. |
| `sourceMatch` | ✓      | `extractIdFromUrl` regex on `furaffinity.net/view/<id>`. Fluffle already returns FA URLs, so reverse-search → tag import lights up for free.                                                               |
| `search`      | ✗ (v1) | Wireable, but deliberately skipped — see "Search and score" below. Omitting `searchPosts` cleanly excludes FA from Explore; the degradation path already exists.                                           |
| `vote`        | ✗      | FA has no voting and exposes no numeric score.                                                                                                                                                             |

#### Search and score

Probed at `/search/?q=wolf` (48 results, HTTP 200):

- **`order-by` accepts `relevancy`, `date`, `popularity`.** So a popularity sort _does_ exist — the earlier claim that FA has "no score sort" was wrong.
- **But there is no score to read.** No `score`, no `data-score`, no favorites count anywhere in the search results. A post page exposes only **Views** (e.g. 1616) and **Comments** (4); even the favourites count is not rendered.

The consequence for `searchPosts`: FA could satisfy the `sort` field, but never a score-based filter (`score:>100`-style metatags, which boorus support and users expect), and nothing score-like could be displayed in the Explore grid. FA search is also full-text over title/description/keywords rather than tag-indexed, so its results are noisier than the 8 booru engines it would be merged with.

**Verdict: skip `searchPosts` in v1** — not because it is impossible, but to keep v1 to favourites, tags and downloads.

**Correction to the reasoning.** An earlier draft justified this by saying FA search is unusable for Explore. That is too strong, and only holds for two of the three sorts. Explore's **new** sort needs no score at all, and FA serves it well: `/browse/` returns the 48 newest submissions site-wide, every one carrying the full `data-tags` payload, with **strictly descending ids** (verified 2026-08-30). `/search/?q=…&order-by=date` works too, though its results are not perfectly id-ordered.

So the honest split is per sort:

| Explore sort | FA |
|---|---|
| new | ✅ works — `/browse/`, or search with `order-by=date` |
| hot / popular | ❌ needs a score FA does not have |

The obstacle is that the contract has a single `searchPosts`, with no way for an engine to say "I serve new but not popular". Shimmie has the same problem from the other direction — #288 notes its sorts are believed absent and that they "should be disabled for it rather than lying". That is a shared gap in the engine contract, not an FA quirk, and worth solving once for both.

This matters beyond Explore: **discovering a new artist to follow requires seeing their work somewhere**, and a new-sorted FA feed is the only place inside gooncave that would show artists the user does not already follow. See §4.5.

`favorite`/`unfavorite` (Explore actions): **promoted to v1-feasible.** The original report deferred these on the assumption that a separate CSRF fetch was needed. The spike shows the token is already embedded in the post page as `/unfav/<id>/?key=<token>`, and `fetchPostTags` fetches that page anyway — so the action costs one extra GET, not a new auth dance. Ship them if the favorites path lands cleanly; they remain the easiest thing to cut if the token turns out to be short-lived.

### 4.2 Credentials

The infrastructure already exists — **do not** abuse `username`/`apiKey` fields (the old report's recommendation predates migration `0003`):

- `credentialSchema: 'none'` + `supportsSessionCookie: true` — the UI then renders a cookie field (gelbooru already does this).
- The `sessionCookie` column stores the full cookie string: `a=<uuid>; b=<uuid>`. One column, both cookies.
- `checkSessionCookie(site)` hook: fetch a logged-in-only page and verify the username appears — gives the connection test real meaning.
- `username` is still needed (it's in the favorites URL path).

### 4.3 Frictions the wiring does NOT solve

These are the actual design questions, absent from the original report:

1. **`fetchPostTags` is mandatory in the contract** even when `tags` capability is weak. For FA it's an HTML scrape per call, and engines currently have **no timeout, no retry, no shared HTTP wrapper** (only the 4s probe timeout exists). An FA engine should bring its own timeout via `AbortSignal` rather than hang the tagging pipeline on a slow Cloudflare challenge.
2. **`probeMatches` assumes JSON-or-text APIs.** FA answers HTML to everything, so autodetect would match on markup and race 8 other probes in `PROBE_ORDER`. Cheapest correct answer: rely on the `HOSTNAME_MAP` entry (hostname match short-circuits probing) and make `probeMatches` a conservative HTML sniff.
3. **Tag canonicalisation is global and e621-shaped.** Every stored tag passes through the e621-derived alias/implication tables (`services/tagDb.ts`, `lib/tagAliases.ts`) with no per-source opt-out. The sample shows FA keywords are a **mix**: genuinely booru-compatible tags (`male`, `anthro`, `gay`, `size_difference`, `muscular`, `scalie`, `pokemon`) alongside artist and character handles (`luxmori`, `wolfnebulae`, `srishinn`, `momoharu`). The first group benefits from canonicalisation; the second is noise that e621 aliases may rewrite into unrelated tags. Options: (a) accept it — the `invalid_tag`/disambiguation guards already exist and the noise is mostly harmless proper nouns; (b) add a per-engine `skipCanonicalisation` flag. Recommendation: **(a) for v1**, revisit if real corruption shows up. Do _not_ store `s_`/`t_` values — they are defaults on nearly every post (§3) and would add pure noise.
4. **The favorites-sync gate requires non-null `username` AND `apiKey`** (`services/favorites.ts`). FA has no apiKey — the gate needs to accept `sessionCookie` as the credential for engines that declare it. Small change, but it touches the sync path shared by all engines.
5. **Engines bypass the SSRF guard** (they import raw `undici` fetch, unlike `safeFetch` used elsewhere). Not FA-specific, but a new scraping-heavy engine is the moment to notice it.

### 4.4 Reverse image search via Fluffle

**Already works.** Fluffle returns `furaffinity.net/view/<id>` URLs today. Once `extractIdFromUrl` + `fetchPostTags` land, those results become actionable through the existing reverse-search → tag pipeline. No extra work.

### 4.5 Following artists — and the subscriptions feature

FA's headline feature that no booru in the registry has: you **watch artists**, and FA aggregates their new submissions into a feed. Probed empirically (`spikes/furaffinity/watch.mts`, run 2026-08-30):

| endpoint                | result                                                                 | shape                                                          |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `/watchlist/by/<user>/` | 200, **92 `/user/` links** on one page                                 | plain `/user/<name>/` anchors; no pagination seen at this size |
| `/msg/submissions/`     | 200, **48 new submissions**, each with full `data-tags` + rating class | cursor pagination: `/msg/submissions/new~<id>@48/`            |
| `/gallery/<artist>/`    | 200, **48 submissions**/page, ids strictly descending                  | numeric pages: `/gallery/<artist>/2/`                         |
| `/user/<artist>/`       | 200, renders exactly one of `/watch/` or `/unwatch/` with a token      | the follow action, and a state oracle for it                  |

Four findings that shape the design:

1. **The inbox is a complete feed, not just links.** Every one of the 48 figures carries the same `data-tags` payload as a post page, plus the rating in its class. One HTTP request yields 48 new posts with artist, keywords, category and rating — no per-post fetch. This is far cheaper than the 1 + N pattern assumed elsewhere in this report.

2. **Following is writable, not just readable** (`spikes/furaffinity/follow.mts`). An artist's user page carries `/watch/<name>/?key=<token>` or `/unwatch/<name>/?key=<token>` — never both — exactly like the fav/unfav pair in §3. Verified on a followed artist (`/unwatch/`, button "Unwatch"), a non-followed one (`/watch/`, button "Watch"), and logged out (neither). So gooncave can follow and unfollow on the user's behalf, and can read the current state without acting.

   ⚠️ The first run of this probe tested an artist taken from the **favourites** page and reported "not followed" for someone assumed to be followed. Favouriting a post does not mean you follow its artist. Pick test names from `watchlist.html`.

3. **The watchlist listing includes the viewer.** The 92 anchors contain the user's own `/user/<self>/` header link, so the real count is 91 artists. A parser must drop the viewer, or the account subscribes to itself.

4. **Gallery ids are monotonically descending**, so a per-artist backfill is the classic "fetch page 1, stop at the newest id already stored" — no date parsing, no cursor bookkeeping.

#### How this meets the app's subscriptions feature

Subscriptions are **not implemented** — `'subscribed'` is a placeholder tab in `frontend/src/features/explore/ExploreView.tsx:20-24`, short-circuited before any fetch in `useExploreController.ts:149-155`. The spec is issue #293: a textarea of **tags** to follow, whose matches fill the Subscribed tab.

That spec is booru-shaped: a subscription is a _tag_, resolved through `searchPosts`. FA does not fit it — §4.1 rules `search` out, because FA's tag search is too weak to be worth wiring.

The reconciling idea is to define a subscription as **a query that yields a post list ordered by descending id**, and let each engine decide what the query means:

| source             | subscription is…   | resolved by                                       |
| ------------------ | ------------------ | ------------------------------------------------- |
| boorus (8 engines) | a tag              | existing `searchPosts(tags)`                      |
| FurAffinity        | an artist username | `/gallery/<artist>/` page 1, stop at last-seen id |

Both then reduce to "show me what these sources have, newest first", which is what the Subscribed tab renders.

#### No read-tracking is needed

An earlier draft of this section claimed the feature needs a last-seen id per subscription. It does not, and the claim is withdrawn.

`GET /explore/posts` (`routes/explore.ts:86`) fans out to every site on every request and stores nothing — Explore is a live, stateless query. A chronological Subscribed tab built the same way shows whatever the sources return; there is nothing to mark as seen. Last-seen state would only buy an unread count or a "new since last visit" divider, and #293 asks for neither.

#### The real constraint is request volume

It affects `kind: 'artist'` only:

| kind | cost of opening the tab |
|---|---|
| `tag` (8 booru engines) | one `searchPosts` per site — same as Explore today |
| `artist` (FurAffinity) | **one HTML page fetch per artist** |

A booru answers "everything tagged X" in a single request. FA has no such query: following 91 artists means 91 separate gallery pages, ~97 KB each. Spaced politely that is minutes; sent in parallel it hammers a host whose rate limit is still unmeasured (§3, Coverage). Neither is acceptable while a user waits for a page to render.

#### Two candidate designs for the FA side

**A. Poll each watched artist's gallery in the background.** Gooncave owns the subscription list; `/watchlist/by/<user>/` becomes a one-click **import** so the user does not retype 91 names.

- Uniform with the booru model above, and independent of FA's inbox state.
- But 91 requests per cycle only fits a background cadence — the favorites auto-sync already runs at local midnight (`backend/src/worker.ts:843-857`). Serving the tab from it means storing results, so this reintroduces a worker and a table that the `tag` path does not need.

**B. Mirror FA's submission inbox.** One request to `/msg/submissions/` returns the 48 newest submissions across everyone the account follows, already merged and chronological, carrying full `data-tags` and rating (§3).

- Exactly the shape a live feed wants, and it keeps both kinds stateless.
- The cost: the inbox is FA's notification queue, not a query. If the user clears it while browsing FA normally, the tab shows less.
- It also ties "who you follow" to the FA account rather than to gooncave.

**Decided (2026-08-30): B.** With the tab as a live query, B keeps `tag` and `artist` on the same stateless footing — no worker, no new table — and opens in one request instead of ninety-one. A's objection to B was that the inbox is state gooncave does not control; that objection carried weight only while the design assumed a stored feed, and nothing is being stored either way. The failure mode is a thinner tab, not lost data.

If the cleared-inbox degradation proves annoying in real use, A becomes the fallback and can backfill from galleries — nothing here is thrown away.

**Decided (2026-08-30): the subscription target is typed, `{kind: 'tag' | 'artist', value}`, and FurAffinity is in scope for subscriptions.** The original #293 spec — a free-form tag per row — cannot express an artist, and FA's search is not usable as a substitute (see "Search and score" in §4.1), so a bare tag would have excluded FA permanently from the one feature it serves best.

This couples #293 and #295: resolving an `artist` subscription needs a reader for `/msg/submissions/`, which is not part of the engine's v1 favourites/tags scope. Whichever issue lands second picks it up.

#### Who owns the follow list

Choosing the inbox as the feed source has a consequence worth stating outright, because it is easy to miss: **for `kind: 'artist'`, the subscription list is FA's watchlist, not a list gooncave keeps.** The inbox returns everyone the account follows. A `tag` row is a local string the user typed; an artist row describes state living on FA.

That leaves two coherent shapes, and they are not interchangeable:

- **Mirror.** The artist rows in settings *are* the FA watchlist. Adding a row calls `/watch/`, removing one calls `/unwatch/`, and the list is read back from `/watchlist/by/<user>/`. What the settings screen shows is what FA has.
- **Local filter.** Gooncave keeps its own list and narrows the inbox to it. Following in gooncave then does not follow on FA, so the same artist can be "subscribed" here and unfollowed there — two sources of truth for one idea.

**Mirror is the right shape**, and finding 2 above is what makes it possible: watch and unwatch are reachable with the same token pattern as favourites, so gooncave can offer a follow button rather than sending the user to FA's site. The local-filter variant would need the inbox filtered per row anyway, which is the same request plus a divergence bug.

The UX consequence to design for: editing artist rows performs **remote writes**, while editing tag rows does not. The settings screen should not present the two as the same kind of text field.

#### Unfollowing is easy; following needs somewhere to discover artists

The two directions are not symmetric, and it is worth separating them.

**Unfollow is well served.** Every item in the Subscribed feed already names its artist — `u_<name>` sits in the same `data-tags` attribute the post metadata comes from — so an unfollow control on an FA post needs no extra lookup to know *who*. It costs one request at click time to read the token from `/user/<name>/`. Beware the prefix quirk from §3: `~Peyote` arrives as `u__peyote`, so strip leading underscores before building the URL.

**Follow has no natural home yet**, because the feed only ever shows artists the user already follows. Three places could offer it, in descending order of reach:

1. **A new-sorted FA feed in Explore.** The only surface that would show artists the user does *not* follow. This is what makes the sort question above a feature question rather than a scoping detail.
2. **Reverse image search results.** Fluffle already returns `furaffinity.net/view/<id>` URLs (§4.4), so a match identifies an artist worth following.
3. **FA files already in the library.** Anything pulled in by favourites sync carries `u_<artist>`, so a file detail view can offer "follow this artist".

2 and 3 work without Explore, but both require the user to already have the work in hand. Only 1 supports discovery. **If FA never enters Explore, gooncave can unfollow but not meaningfully follow** — the subscription list would only ever shrink, and growing it means going to FA's website.

## 5. Three strategies, compared

### A. Manual cookies + plain HTTP (`undici`) — ✅ **recommended**

- **Cost:** lowest. One engine module (~gelbooru-sized) + the frictions in §4.3. No new backend dependency (§10).
- **UX:** user copies two cookies from DevTools into the site settings, and redoes it when they expire. "Advanced user" UX.
- **Robustness:** the Cloudflare question is now answered — plain HTTP passes (§3). Remaining risk is selector rot on FA redesigns, which is ordinary scraping maintenance and is contained to one file.
- **Verdict:** the spike's preconditions are met. Pick this.

### B. Headless browser (Playwright) — ❌ ruled out

- **Cost:** ~150 MB of Chromium in the Docker image, hundreds of MB at runtime.
- **Verdict:** its only justification was defeating a Cloudflare JS challenge. There is no challenge to defeat. Paying that cost now would buy nothing.

### C. External proxy ([faexport](https://github.com/Deer-Spangle/faexport), self-hosted) — ❌ not worth it

- **Cost:** near-zero parsing code, but a new operational dependency: a Ruby/Sinatra container the user must run, fed with their cookies.
- **New objection from the spike:** faexport parses the **classic** theme, while the account tested runs **beta/modern**. Adopting it would force users to switch their FA theme site-wide — a worse imposition than pasting two cookies.
- **Robustness:** delegates selector maintenance, but inherits faexport's bugs and outages. It even ships an optional "Cloudflare bypass" side-container, which we now know we don't need.
- **Verdict:** more operational burden than the thing it replaces.

### Decision

**Strategy A.** Cloudflare passed on 7/7 requests, 48/48 favorites and 5/5 post metadata parsed, and the fav/unfav token is already in the page. B and C both existed to solve a Cloudflare problem that does not exist.

## 6. Effort sketch

For the chosen strategy A:

| Item                     | Detail                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New files                | 1 — `backend/src/lib/booruEngines/furaffinity.ts`                                                                                                                                                       |
| Modified files           | 6 registration points (§4) + the favorites-sync credential gate (§4.3, friction 4)                                                                                                                      |
| New dependencies         | None — every field FA needs was extracted by regex and checked against cheerio on 14 saved pages (§10)                                                                                                  |
| Schema migrations        | None — the `sessionCookie` column shipped in `0003`                                                                                                                                                     |
| Selectors already proven | `figure[id^="sid-"]` (favorites), `img#submissionImg[data-tags]` (tags + category + artist), `data-fullview-src` (download), `c-contentRating--<level>` (rating), `/unfav/<id>/?key=` (fav state + action token) |

Reusable as-is from the spike: the header set that passes Cloudflare, and both parser functions.

## 7. Risks & disclaimers

If FA support ships, the in-app credentials screen must carry a clear warning:

> ⚠️ FurAffinity does not provide an official API. To sync your favorites, gooncave reads your favorites pages using your session cookies. This is technically against FurAffinity's Terms of Service. Use at your own risk; rate limits are conservative to minimize the chance of detection. Do not log out of the browser session the cookies came from.

## 8. Decision

**Recorded 2026-08-30: proceed with strategy A.** The spike answered its question — scraping FA from inside gooncave is feasible with plain HTTP, and the engine registry absorbs it without new abstractions.

Scope for the follow-up implementation issue:

- **v1:** `favorites` (sync, including **remote removal** — the `/unfav/` link and its state oracle are confirmed, §3), `tags` (`fetchPostTags` via `data-tags`), `sourceMatch`, `favorite`/`unfavorite`, plus the ToS warning in §7.
- **Explicitly out of v1:** `searchPosts` (skipped by choice — see "Search and score" in §4.1) and `vote` (FA has neither voting nor a numeric score).
- **Carry over the two spike bug-fixes:** use `fetch` not `request` (decompression), and target the beta-theme selectors listed in §6 — not the sidebar the original parser assumed.
- **Bound the scrape:** engines have no shared timeout or retry infrastructure (§4.3, friction 1). The FA engine must pass its own `AbortSignal` deadline rather than let a slow page stall the tagging pipeline.
- **First live test:** following a `/fav/` or `/unfav/` link was deliberately never executed during the spike. Implementation starts by verifying that mutation and the token's lifetime.

Subscriptions (§4.5) are tracked separately in #293 — they are a different feature that FA happens to serve well, not part of the engine's v1.

That issue is **[#295](https://github.com/LiukScot/gooncave/issues/295)**, and #7 is closed against it.

> **Caveat on sample size:** the empirical results come from one account, one theme, 7 requests, on 2026-08-30. They prove scraping works _today_, not that it is stable. Cloudflare posture and FA markup can change without notice; treat the engine as maintenance-bearing code, not fire-and-forget.

## 9. Gap verification — executed 2026-08-30

The gaps §3 left open were run against live FA. Scripts:
`spikes/furaffinity/verify.mts` (read-only, points 3-7),
`mutate.mts` (point 1, mutates a real account),
`ratelimit.mts` (point 2). 130+ requests, all spaced.

| gap | outcome |
| --- | --- |
| Executing a fav/unfav, key lifetime | ✅ works — but the response proves nothing, see below |
| Rate-limit tolerance | ✅ no limit down to 250 ms spacing, 60 sequential requests |
| `/scraps/<artist>/` | ✅ exists, same shape, disjoint from `/gallery/` |
| Gallery folders | ⚠️ walking `/gallery/` does **not** reach everything |
| URL variants | ✅ regex settled — plus two host traps |
| Deep pagination | ✅ 655 and 720 favourites walked, no drift |
| Logged-out view of mature posts | ✅ hidden — 22 KB page, no `img#submissionImg` |
| `probePath` / `probeMatches` | ✅ HTML markers are stable and `detect.ts` already tolerates non-JSON |

### 9.1 The write path works, and its response is worthless

Executed net-zero on submission `66201356`: favourite → verify → unfavourite →
verify, account restored.

`/fav/<id>/?key=<64 hex>` and `/unfav/<id>/?key=…` are plain GETs. Both answer
**302 to `/view/<id>/` with an empty body** — and so does a request carrying a
key of 64 zeroes, which changes nothing. **The status code is not a result.**
The only way to know whether a mutation landed is to re-read the submission
page and look at which of `/fav/` or `/unfav/` it now renders.

This is the same shape as the gelbooru problem in #144, with one difference
that matters: gelbooru's re-scrape is a heuristic, FA's is an exact oracle,
because the two links are mutually exclusive.

The token:

- **per-submission** — two submissions never share one.
- **regenerated on every render** — three loads of the same page yielded three
  different keys. Do not cache it as "the session's key".
- **not single-use** — a key still worked **10 minutes** after capture, and
  replaying a spent one is idempotent (it does not toggle the favourite back
  off).
- **fails silently** — a wrong key is a 302 like any other.

So `favorite()` costs two requests (read the token, spend it) plus one more if
the caller wants proof. A token read for one purpose can be reused for a later
mutation within at least a 10-minute window.

### 9.2 No rate limit found at 4× the spike's pace

60 sequential requests for distinct gallery pages, in rungs of 15 at 2000,
1000, 500 and 250 ms spacing. Every one returned 200 with a full 48-tile
listing. No `Retry-After`, no Cloudflare interstitial, and mean latency flat
across the rungs (536-589 ms), so nothing was being throttled quietly either.

Sustained ~1.2 req/s is therefore safe. Design A in §4.5 — 91 artist galleries
per cycle — comes to roughly 80 seconds: fine for a background job, still far
too slow to serve a tab the user is waiting on. That is unchanged support for
**design B**.

Parallel bursts were deliberately not tested; they are the fastest way to earn
a block and the sequential number already answers the design question.

**A trap for whoever measures this next:** a gallery page past the last one
returns **200 with zero tiles and ~50 KB**. The first run of `ratelimit.mts`
walked off the end of the gallery and reported a false rate limit.

### 9.3 `/scraps/` is a second, disjoint gallery

Checked on `luxmori`, `blitzdrachin` and `ajin`: `/scraps/<artist>/` returns
the same `figure[id^="sid-"]` tiles, 48 per page, paginated the same way, and
its ids never appear in `/gallery/` — zero overlap against 672 walked gallery
ids on `blitzdrachin`. Polling only `/gallery/` silently drops everything an
artist filed as a scrap.

### 9.4 A folder can hold submissions the gallery never shows

This one came back worse than expected. `blitzdrachin` advertises 19 folders.
The folder `/gallery/blitzdrachin/folder/5995/Paintings` lists 48 submissions;
walking `/gallery/` page by page found **46 of them**, and the walk continued
past the folder's oldest id without ever producing the other two
(`50317276`, `47722567`). Both are still online and both carry
`u_blitzdrachin`, so they are not deleted and not someone else's.

FA lets a submission live in a folder while being hidden from the main
gallery. Consequences:

- `/gallery/` is **not** a superset of the folders, and the folders are not a
  partition of it — they intersect.
- Complete coverage of one artist is `/gallery/` ∪ `/scraps/` ∪ every folder,
  which is 19+ extra requests for this one artist.
- Design B (the `/msg/submissions/` inbox) is untouched by this: the inbox
  carries whatever the artist published, regardless of where it was filed.

### 9.5 Host normalisation is mandatory before any fetch

`extractIdFromUrl` needs nothing more than:

```ts
const HOST_RE = /^(?:www\.|sfw\.)?furaffinity\.net$/i;
const m = /^\/(?:view|full)\/(\d+)\/?$/.exec(url.pathname);
```

which accepts `www`, bare, `http`, `sfw`, `/full/` and a trailing `#cid:` and
rejects `journal`, `user` and lookalike hosts. Fetching those URLs is the part
with teeth:

| URL | result |
| --- | --- |
| `www.furaffinity.net/view/<id>/` + cookies | 200, 68 KB, logged in, image present |
| same, anonymous | 200, 22 KB, **no `img#submissionImg`** |
| `furaffinity.net/view/<id>/` + cookies | 301 → www, **arrives logged out** |
| `sfw.furaffinity.net/view/<id>/` + cookies | 200, logged in, **image still hidden** |
| `www.furaffinity.net/full/<id>/` + cookies | identical to `/view/` |

The bare host redirects to `www`, and the redirect is cross-origin, so `fetch`
strips the `Cookie` header on the way — the engine ends up parsing an
anonymous page and concluding the session is dead. `sfw.` keeps the session
but serves the SFW view, which omits mature and adult artwork entirely.

**Rewrite the host to `www.furaffinity.net` before requesting, never rely on
FA's redirect.**

The anonymous row also closes the separate "logged-out view of mature posts"
gap: they are not visible at all, so a missing `img#submissionImg` means
either a dead session or a missing submission, and §3 trap 3 already covers
telling those apart.

### 9.6 Pagination holds at depth

| account | pages walked | distinct ids | duplicates |
| --- | --- | --- | --- |
| `FuzzyLiuk` | 14 (to the end) | 655 | 0 |
| `blitzdrachin` | 15 (stopped by the cap) | 720 | 0 |

Cursors decrease strictly, page size stays at 48 until the final short page,
and latency is flat from first page to last. The 144 items §3 reports were
simply where that walk stopped, not where the listing ended.

**The cursor is a `form` action, not a link.** `form[action*="/next"]` is
right; an `a[href*="/next"]` selector matches nothing and makes page 1 look
like the last page. The first run of this verification did exactly that and
reported 48 favourites.

### 9.7 Autodetect needs no new plumbing

`detect.ts` sends `Accept: application/json, application/xml;q=0.8, */*;q=0.5`
with no cookies, then falls back to the raw text body when the response is not
JSON (`detect.ts:128-135`). FA answers 200 with normal HTML to that request, so
the existing path already works. Markers available anonymously:

| marker | `/` | `/browse/` |
| --- | --- | --- |
| `<title>` | `Index -- Fur Affinity [dot] net` | `Browsing Artwork -- Fur Affinity [dot] net` |
| `meta[name=description]` | `Fur Affinity \| For all things fluff, scaled, and feathered!` | same |
| `body` id | `pageid-frontpage` | `pageid-browse` |
| `figure[id^="sid-"]` | 112 | 48 |

`probePath: '/'` with a `probeMatches` keyed on the `Fur Affinity [dot] net`
title suffix plus a `pageid-` body id is enough, and neither depends on the
session.

## 10. Implementation checklist — audited against the code 2026-08-30

§4 was written from a reading of the architecture. This is the same ground
walked file by file, with what changed.

### 10.1 No new dependency: the parser is `String.matchAll`

§4 assumed `cheerio`. The backend has no HTML parser and does not need one —
gelbooru scrapes with `String.matchAll` (`gelbooru.ts:135`), and AGENTS §6
forbids a dependency for what a few lines of stdlib do.

`spikes/furaffinity/parse-regex.mts` extracts every field the engine needs with
regex and diffs each one against cheerio as the oracle, over the 14 pages the
spike saved (favourites, three galleries, three scraps pages, the inbox, the
watchlist, a submission, a missing submission, home, browse). **All fields
agree.** The functions in that script are the parser, ready to be lifted:

| field | pattern |
| --- | --- |
| listing ids | `/<figure[^>]*\bid="sid-(\d+)"/g` |
| favourites cursor | `/<form[^>]*\baction="(\/favorites\/[^"/]+\/\d+\/next)"/` |
| per-tile rating | `r-(general\|mature\|adult)` on the `<figure>` tag |
| per-tile thumb / artist | first `<img src>` / first `/user/<name>` inside the tile |
| tags, full-res URL | `data-tags` / `data-fullview-src` on the `img#submissionImg` tag |
| post rating | `c-contentRating--(\w+)` |
| fav state + token | `href="/(fav\|unfav)/\d+/?key=([0-9a-f]+)"` |
| missing submission | absence of `img#submissionImg` (877-byte 200, verified) |

One trap the oracle caught: tiles must be split on `</figure>` **and then
trimmed forward to the `<figure` tag**. Without the trim, the first chunk
carries the page header and yields the logged-in user as the first tile's
artist and a menu icon as its thumbnail — wrong values, not a crash.

### 10.2 The registration points are seven, not six, and one should be skipped

| # | file | note |
| --- | --- | --- |
| 1 | `backend/src/db/types.ts:85` | `BooruEngineType` union — lowercase `'furaffinity'` |
| 2 | `backend/src/lib/booruEngines/index.ts:17` | `ENGINE_REGISTRY` entry + re-export at the bottom |
| 3 | `backend/src/lib/booruEngines/detect.ts:35` | `HOSTNAME_MAP` — `/^(?:www\.\|sfw\.)?furaffinity\.net$/i` |
| 4 | `backend/src/lib/booruEngines/detect.ts:58` | `PROBE_ORDER` — **skip it**, see below |
| 5 | `backend/src/routes/booruSites.ts:17` | `engineEnum`, hand-duplicated from the union |
| 6 | `frontend/src/features/booru-sites/shared.ts:3` | `ENGINE_LABELS`, exhaustive `Record` |
| 7 | `backend/src/lib/booruEngines/presets.ts:10` | `BOORU_PRESETS` — **missing from §4** |

Point 7 matters more for FA than for any existing engine: every other engine is
software someone self-hosts, so a user types their own base URL. FA is one
website. Without a `FURAFFINITY` preset pointing at `https://www.furaffinity.net`
the only way to add it is to type the URL by hand.

Point 4 should be left alone. `detect.ts:194` fires **all** of `PROBE_ORDER` in
parallel against whatever base URL the user typed, so adding FA means one extra
HTML fetch on every detection of every other site, to look for a marker that can
only ever appear on one domain — which `HOSTNAME_MAP` already routes
(`detect.ts:181-189` short-circuits and skips the race entirely). §4.3 friction 2
worried FA's HTML would race the eight JSON probes; the answer is that it never
needs to enter the race.

`probePath`/`probeMatches` are still mandatory fields on the module, and
`detect.ts` runs the matched engine's probe even on a hostname hit, for the
proof-of-life thumbnail. `probePath: '/'` matching on the `Fur Affinity [dot] net`
title suffix satisfies both (§9.7).

### 10.3 The credentials gate blocks FA in four places, not one

§4.3 friction 4 calls this "small". It is four separate `username && apiKey`
checks in `services/favorites.ts`, each with its own error message:

| line | path | effect on FA |
| --- | --- | --- |
| `favorites.ts:59` | `loadFavoriteSyncableSites` | the nightly sync silently skips the site |
| `favorites.ts:465` | `favoriteFromExplore` | "has no API key: add one under Settings" |
| `favorites.ts:521` | `unfavoriteFromExplore` | same |
| `favorites.ts:659` | auto-favourite on scan | `credentials-missing` |

FA is `credentialSchema: 'none'` + `supportsSessionCookie: true` + a `username`
(the favourites URL contains it), so all four reject it. The fix is one shared
predicate — "does this site have the credentials its engine actually needs" —
used in all four places, rather than four edits to the same boolean.

`exploreDownloadHeaders` (`favorites.ts:420`) needs no change: it attaches Basic
auth only for `username+apikey` engines whose file host matches the site host.
FA is neither, so downloads from `d.furaffinity.net` go out with just the User-
Agent — which is correct, they need no credentials (§3).

### 10.4 Contract obligations

`BooruEngineModule` (`types.ts:106-179`) makes four members mandatory:
`fetchPostTags`, `probePath`, `probeMatches`, `extractIdFromUrl`,
`buildPostUrl`, plus the descriptive fields. Everything the v1 scope needs
beyond that — `fetchFavorites`, `favorite`, `unfavorite`, `checkSessionCookie`
— is optional, and `searchPosts`/`vote`/`fetchPostByMd5` stay absent, which is
how a capability gets declined.

`buildPostUrl` and every fetch must build on `https://www.furaffinity.net`
regardless of what the site row stores, per §9.5.

Engines call `undici` directly rather than `safeFetch` (§4.3 friction 5 — still
true; `safeFetch` appears only in `detect.ts`). FA's URLs are all built from a
fixed host rather than from user input, so this adds no new exposure, but it
also means the FA engine cannot rely on the SSRF guard for anything.
