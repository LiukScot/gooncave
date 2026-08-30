# FurAffinity feasibility spike

> ⚠️ **This is a SPIKE, not production code.** It exists to answer one question for issue #7:
> _"Can we realistically scrape FurAffinity for favorites + tags from inside gooncave?"_
>
> Nothing in this folder is imported by the gooncave backend. It can be deleted at any time without breaking anything.

## What it does

Two tiny standalone scripts:

1. **`probe.ts`** — does a couple of authenticated HTTP requests to FA using your session cookies and reports:
   - Whether Cloudflare let us through (`200 OK` vs `403/503` + challenge HTML).
   - Whether the session cookies are still valid (does the returned HTML show your username in the header?).
   - Headers worth noting (`cf-ray`, `set-cookie: __cf_bm`, `server`).
   - Saves raw HTML of the favorites page and one post page to `out/` for inspection.

2. **`parse.ts`** — runs **only after `probe.ts` succeeded**. Parses the saved HTML with Cheerio and prints:
   - First 5 favorites extracted from the favorites page (id, thumbnail URL, title, artist).
   - All tags extracted from the post page (with category if FA exposes one).

If both scripts work end-to-end, scraping FA is feasible. If `probe.ts` is blocked by Cloudflare, scraping with plain HTTP is **not** feasible and we'd need a headless browser (Playwright) or an external proxy (e.g. faexport).

## Setup

```bash
cd spikes/furaffinity
npm install
cp cookies.example.json cookies.json
# Edit cookies.json with your real FA cookies (see below)
```

### How to get your FA cookies

1. Log in to <https://www.furaffinity.net/> in your normal browser.
2. Open DevTools → **Application** tab → **Cookies** → `https://www.furaffinity.net`.
3. Copy the values of the cookies named **`a`** and **`b`** into `cookies.json`.
4. Set `username` to your FA username (lowercase, used to build the favorites URL: `/favorites/<username>/`).
5. Pick any one of your favorited submissions, copy its numeric ID from the URL (`furaffinity.net/view/<ID>/`), and put it in `samplePostId`.

`cookies.json` is `.gitignore`d — it will never be committed.

## Run

```bash
# Step 1: probe Cloudflare and save HTML
npm run probe

# Step 2 (only if step 1 said CLOUDFLARE: PASSED): parse the saved HTML
npm run parse
```

## Expected output

### `probe.ts` (success case)

```
[probe] reading cookies.json...
[probe] requesting https://www.furaffinity.net/favorites/yourname/
[probe]   status: 200
[probe]   bytes: 184231
[probe]   server: cloudflare
[probe]   cf-ray: 8a1b2c3d4e5f6789-FCO
[probe]   set-cookie __cf_bm: yes
[probe]   saved -> out/favorites-page1.html
[probe]   session marker (your username in header): FOUND
[probe] CLOUDFLARE: PASSED
[probe] requesting https://www.furaffinity.net/view/12345678/
[probe]   status: 200
[probe]   saved -> out/view-12345678.html
[probe] done.
```

### `probe.ts` (blocked case)

```
[probe]   status: 403
[probe]   body starts with: <!DOCTYPE html><html lang="en-US"><head><title>Just a moment...
[probe] CLOUDFLARE: BLOCKED  (challenge page detected)
```

## Cleanup

When the spike is no longer needed, just delete this whole folder:

```bash
rm -rf spikes/furaffinity
```

The gooncave backend has no dependency on it.
