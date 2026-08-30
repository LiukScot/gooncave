# FurAffinity integration — feasibility report

> **Issue:** [#7](https://github.com/LiukScot/gooncave/issues/7) — _Verificare possibile implementazione di furaffinity in sync fav, tags, download etc_
>
> **Status:** ✅ **FEASIBLE** — spike executed 2026-08-30 against a real account. Cloudflare passed, session cookies authenticated, favorites and tags parsed. Recommended path: **strategy A** (§5).
>
> **Revision note (2026-08):** this report was rewritten against the current engine-registry architecture (`backend/src/lib/booruEngines/`). The original version predated that refactor and referenced code that no longer exists (`dataStore.ts`, `resolveE621Auth`, the `syncProvider()` switch).

## 1. Executive summary

Gooncave integrates external sources through pluggable **booru engines** (8 today: e621, danbooru, gelbooru, moebooru, philomena, sankaku, shimmie, szurubooru). All of them talk to REST/JSON APIs — except gelbooru's favorites path, which already scrapes HTML behind a session cookie. That precedent matters: **an FA engine is "gelbooru's favorites path, but for every method".**

FurAffinity has **no public API**: only HTML pages behind session cookies, with **Cloudflare bot protection** in front. The engine registry makes the _wiring_ cheap (6 mechanical registration points), but three architectural frictions are not wiring problems and need decisions — see §5.

This report:

1. Documents the current engine contract and what FA can/cannot fulfil.
2. Names the architectural frictions that the wiring alone doesn't solve.
3. Compares three strategies (manual cookies / headless browser / external proxy).
4. Defines the empirical question the spike answers, so the strategy is picked on evidence.

## 2. The four blockers

| #   | Blocker                | Severity                                  | Notes                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No public API**      | High — _confirmed, unavoidable_           | All scraping is HTML. No JSON, no MD5 lookup, no batch endpoints. Every method costs a full page fetch (~40–100 KB).                                                                                                                                                                                      |
| 2   | **Cloudflare WAF**     | ~~Unknown~~ → **Resolved, not a blocker** | Plain `undici` + browser-like headers returned HTTP 200 on 7/7 requests. No challenge, no `__cf_bm` cookie issued.                                                                                                                                                                                        |
| 3   | **Cookie-only auth**   | Medium — _confirmed_                      | No API key. Users extract cookies `a` and `b` from their browser and must **not log out** of that session afterwards, or the cookies die.                                                                                                                                                                 |
| 4   | **ToS violation risk** | Medium                                    | FA's ToS forbids automated scraping. Users could in principle get banned. Mitigation: clear in-app warning + conservative rate limit.                                                                                                                                                                     |
| 5   | **Theme fragility**    | Medium — _confirmed relevant_             | FA serves two themes and every scraper is pinned to one. The spike account runs **beta/modern** (`/themes/beta/`), which is what our selectors now target. [faexport](https://github.com/Deer-Spangle/faexport) requires _classic_ — see §5.C. A user switching theme, or FA redesigning, breaks parsing. |

## 3. The spike

Location: [`spikes/furaffinity/`](../../spikes/furaffinity/)

The spike is intentionally **isolated** — its own `package.json`, its own dependencies (`undici`, `cheerio`), not imported by the backend. It can be deleted without breaking anything.

### What it tests

- **`probe.ts`**: _"Can plain HTTP requests with session cookies reach FA's authenticated favorites page, or does Cloudflare block us?"_ Dumps raw HTML to `out/` for inspection.
- **`parse.ts`**: _"If we get the HTML, can we parse the structured data we need (favorite IDs + thumbnails + keywords) with stable CSS selectors?"_

### How to run

See [`spikes/furaffinity/README.md`](../../spikes/furaffinity/README.md). TL;DR:

```bash
cd spikes/furaffinity
npm install
cp cookies.example.json cookies.json   # then edit with real FA cookies
npm run probe
npm run parse
```

### Empirical results — executed 2026-08-30

Run against a real account on the **beta/modern** theme. 7 requests total (1 favorites page, 6 submission pages), issued sequentially with a 2 s gap on the batch.

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
[probe] CLOUDFLARE: PASSED  (HTTP 200, 98436 bytes of HTML)
[probe]   session marker (<user> in header): FOUND
[probe] requesting https://www.furaffinity.net/view/64670793/
[probe]   status: 200
[probe]   bytes: 68336
[probe]   verdict: PASSED  (HTTP 200, 68336 bytes of HTML)
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

**Cloudflare verdict: PASSED.** 7/7 HTTP 200. No interstitial, no `Just a moment...`, no `__cf_bm` cookie set. Plain `undici` with browser-like headers is sufficient — **no headless browser needed**.

**Selectors verdict: PARSEABLE.** 48/48 favorites extracted from page 1 (id, thumbnail, title, artist). Post metadata extracted on 5/5 sampled submissions.

#### Two spike bugs found and fixed during execution

1. **`probe.ts` used `undici.request()`**, which does _not_ decompress responses. The saved HTML was raw gzip, so the "are we logged in?" check searched a compressed buffer and reported a **false** `NOT FOUND`. Switched to `undici.fetch()`, which decompresses. Without this fix the spike would have concluded "cookies expired" while the session was perfectly valid.
2. **`parse.ts` targeted a sidebar that does not exist** in the beta theme (`div.submission-sidebar`, `strong` labels), so category/rating/species all read `(not found)`. Replaced with the real source — see below.

#### Key finding: `data-tags` carries all metadata in one attribute

`img#submissionImg` exposes everything except the rating in a single space-separated attribute, with namespace prefixes:

```
u__peyote c_artwork_digital t_all s_unspecified_any male sheath sweat hug pecs
^artist   ^category         ^theme ^species         ^------- keywords -------^
```

The `/search/@keywords` anchors carry the same keywords (matched exactly on 4/5 samples; one post differed in ordering/dedup), but the attribute is the better source: one lookup, no per-anchor iteration. The rating is separate, rendered as a `Rating--<level>` class.

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

**Rating is available in listings, not just on the post page.** Each `<figure>` carries `class="r-adult t-image"` / `r-general` / `r-mature`, so a listing scrape gets the rating without opening the submission. Distribution on the 48-item sample: 27 adult, 12 mature, 9 general. The `Rating--<level>` regex is only needed on the post page itself.

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

1. `backend/src/db/types.ts` — add `'FURAFFINITY'` to the `BooruEngineType` union
2. `backend/src/lib/booruEngines/index.ts` — `ENGINE_REGISTRY` entry + re-export
3. `backend/src/lib/booruEngines/detect.ts` — `HOSTNAME_MAP` entry (`furaffinity.net`)
4. `backend/src/lib/booruEngines/detect.ts` — `PROBE_ORDER` entry
5. `backend/src/routes/booruSites.ts` — the hand-duplicated `engineEnum` Zod literal list (miss this and no site can be created with the engine)
6. `frontend/src/features/booru-sites/shared.ts` — `ENGINE_LABELS` (exhaustive `Record`, frontend build fails until added)

### 4.1 Capability mapping

Capabilities are per-engine flags (`defaultCapabilities`); features silently exclude sites whose engine lacks the capability. FA's honest row in the matrix:

| capability    | FA     | How                                                                                                                                                                                                        |
| ------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `favorites`   | ✓      | Scrape `/favorites/<user>/` pages, paginated — 48 entries per page, `figure[id^="sid-"]`. Same pattern as gelbooru's HTML favorites scrape (cheerio ID extraction, in-engine sleeps, abort-aware).         |
| `tags`        | ✓      | `fetchPostTags` scrapes `/view/<id>` and reads `data-tags` (§3). ~14 keywords/post on the sample — usable, not the thin result originally assumed. WD14 still adds value but is no longer the only option. |
| `sourceMatch` | ✓      | `extractIdFromUrl` regex on `furaffinity.net/view/<id>`. Fluffle already returns FA URLs, so reverse-search → tag import lights up for free.                                                               |
| `search`      | ✗ (v1) | Wireable, but deliberately skipped — see "Search and score" below. Omitting `searchPosts` cleanly excludes FA from Explore; the degradation path already exists.                                           |
| `vote`        | ✗      | FA has no voting and exposes no numeric score.                                                                                                                                                             |

#### Search and score

Probed at `/search/?q=wolf` (48 results, HTTP 200):

- **`order-by` accepts `relevancy`, `date`, `popularity`.** So a popularity sort _does_ exist — the earlier claim that FA has "no score sort" was wrong.
- **But there is no score to read.** No `score`, no `data-score`, no favorites count anywhere in the search results. A post page exposes only **Views** (e.g. 1616) and **Comments** (4); even the favourites count is not rendered.

The consequence for `searchPosts`: FA could satisfy the `sort` field, but never a score-based filter (`score:>100`-style metatags, which boorus support and users expect), and nothing score-like could be displayed in the Explore grid. FA search is also full-text over title/description/keywords rather than tag-indexed, so its results are noisier than the 8 booru engines it would be merged with.

**Verdict: skip `searchPosts` in v1** — not because it is impossible, but because mixing a full-text, score-less source into a tag-and-score Explore grid degrades that grid. Revisit only if someone actually wants FA in Explore.

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
| `/watchlist/by/<user>/` | 200, **92 artists** on one page                                        | plain `/user/<name>/` anchors; no pagination seen at this size |
| `/msg/submissions/`     | 200, **48 new submissions**, each with full `data-tags` + rating class | cursor pagination: `/msg/submissions/new~<id>@48/`             |
| `/gallery/<artist>/`    | 200, **48 submissions**/page, ids strictly descending                  | numeric pages: `/gallery/<artist>/2/`                          |

Two findings that shape the design:

1. **The inbox is a complete feed, not just links.** Every one of the 48 figures carries the same `data-tags` payload as a post page, plus the rating in its class. One HTTP request yields 48 new posts with artist, keywords, category and rating — no per-post fetch. This is far cheaper than the 1 + N pattern assumed elsewhere in this report.
2. **Gallery ids are monotonically descending**, so incremental sync is the classic "fetch page 1, stop at last-seen id" — no date parsing, no cursor bookkeeping.

#### How this meets the app's subscriptions feature

Subscriptions are **not implemented** — `'subscribed'` is a placeholder tab in `frontend/src/features/explore/ExploreView.tsx:20-24`, short-circuited before any fetch in `useExploreController.ts:149-155`. The spec is issue #293: a textarea of **tags** to follow, whose matches fill the Subscribed tab.

That spec is booru-shaped: a subscription is a _tag_, resolved through `searchPosts`. FA does not fit it — §4.1 rules `search` out, because FA's tag search is too weak to be worth wiring.

The reconciling idea is to define a subscription as **a query that yields a post list ordered by descending id**, and let each engine decide what the query means:

| source             | subscription is…   | resolved by                                       |
| ------------------ | ------------------ | ------------------------------------------------- |
| boorus (8 engines) | a tag              | existing `searchPosts(tags)`                      |
| FurAffinity        | an artist username | `/gallery/<artist>/` page 1, stop at last-seen id |

Both then reduce to the same "new since last seen" operation, which is what the Subscribed tab renders. This needs one piece of state the repo does not have yet: a last-seen id per subscription (§5 of the architecture map — there is no seen-posts tracking anywhere today; `favorite_items` tracks "already in library", which is a different question).

#### Two candidate designs for the FA side

**A. Poll each watched artist's gallery.** Gooncave owns the subscription list; `/watchlist/by/<user>/` becomes a one-click **import** so the user does not retype 92 names.

- Uniform with the booru model above — one concept, one code path.
- Independent of FA's inbox state.
- Cost: one request per artist per cycle. 92 artists at a polite spacing is minutes, not seconds — acceptable on the existing daily cadence (favorites auto-sync already runs at local midnight, `backend/src/worker.ts:843-857`), unacceptable on demand.

**B. Mirror FA's submission inbox.** One request to `/msg/submissions/` replaces all N gallery polls, and returns richer data.

- Dramatically cheaper and the metadata is free.
- But the inbox is a **stateful notification queue owned by FA, not a query**. If the user clears it while browsing FA normally, gooncave never sees those posts; if nobody clears it, it grows unbounded. Correctness depends on state gooncave does not control.
- It also ties "who you follow" to FA's account rather than to gooncave.

**Recommendation: A as the model, B as an optimisation.** Design the feature around gooncave-owned subscriptions polled per artist, because that is the shape that generalises to the other 8 engines. Use the watchlist endpoint for import. Revisit the inbox only if per-artist polling proves too slow in practice — and if so, treat it strictly as a fast path that a gallery poll can backfill, never as the only source of truth.

Open question for whoever implements #293: whether a subscription's target is a free-form tag (as specced) or a typed `{kind: 'tag' | 'artist', value}`. FA forces the second if it is to participate at all.

## 5. Three strategies, compared

### A. Manual cookies + plain HTTP (`undici` + `cheerio`) — ✅ **recommended**

- **Cost:** lowest. One engine module (~gelbooru-sized) + the frictions in §4.3. `cheerio` is the only new backend dependency.
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
| New dependencies         | `cheerio` (the backend does not use it yet; the spike already validates it against FA's HTML)                                                                                                           |
| Schema migrations        | None — the `sessionCookie` column shipped in `0003`                                                                                                                                                     |
| Selectors already proven | `figure[id^="sid-"]` (favorites), `img#submissionImg[data-tags]` (tags + category + artist), `data-fullview-src` (download), `Rating--<level>` (rating), `/unfav/<id>/?key=` (fav state + action token) |

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

Once that issue is open and linked, #7 can close.

> **Caveat on sample size:** the empirical results come from one account, one theme, 7 requests, on 2026-08-30. They prove scraping works _today_, not that it is stable. Cloudflare posture and FA markup can change without notice; treat the engine as maintenance-bearing code, not fire-and-forget.
