/**
 * FurAffinity implementation-gap verification — gooncave issue #295.
 *
 * The feasibility report left seven items unverified. This covers the five
 * read-only ones; the other two need consent and live in mutate.mts (executing
 * a favourite) and ratelimit.mts (finding the request-rate ceiling).
 *
 *   3. /scraps/<artist>/  — does it exist, same shape, disjoint from /gallery/?
 *   4. gallery folders    — does walking /gallery/ reach every submission?
 *   5. URL variants       — what extractIdFromUrl must accept, and which hosts
 *                           actually serve an authenticated submission
 *   6. deep pagination    — favourites cursor walk well past the 3 pages the
 *                           original spike stopped at
 *   7. probePath/probeMatches — autodetect against a site that answers HTML to
 *                           everything
 *
 * Requests are spaced by REQUEST_SPACING_MS. Env knobs: FA_ARTISTS,
 * FA_FAV_USERS, FA_FAV_PAGES, FA_FOLDER_ARTIST, FA_FOLDER, FA_GALLERY_PAGES.
 */
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const REQUEST_SPACING_MS = 2000;

const cookies = JSON.parse(
  await readFile(path.join(__dirname, 'cookies.json'), 'utf8')
) as { username: string; a: string; b: string; samplePostId: string };

const buildHeaders = (auth: boolean): Record<string, string> => {
  const h: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (auth) h.Cookie = `a=${cookies.a}; b=${cookies.b}`;
  return h;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let requestCount = 0;

const get = async (
  url: string,
  opts: {
    auth?: boolean;
    redirect?: 'follow' | 'manual';
    extraHeaders?: Record<string, string>;
  } = {}
) => {
  if (requestCount > 0) await sleep(REQUEST_SPACING_MS);
  requestCount += 1;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...buildHeaders(opts.auth ?? true), ...(opts.extraHeaders ?? {}) },
    redirect: opts.redirect ?? 'follow'
  });
  const body = await res.text();
  const $ = cheerio.load(body);
  return {
    status: res.status,
    ms: Date.now() - started,
    location: res.headers.get('location'),
    bytes: Buffer.byteLength(body, 'utf8'),
    finalUrl: res.url,
    body,
    $,
    hasImg: $('img#submissionImg').length > 0,
    // the logged-in chrome carries a logout link; the logged-out one does not
    loggedIn: /\/logout\//i.test(body)
  };
};

/** figure[id^="sid-"] is the submission tile every FA listing is built from. */
const ids = ($: cheerio.CheerioAPI): string[] =>
  $('figure[id^="sid-"]')
    .toArray()
    .map((el) => ($(el).attr('id') ?? '').replace('sid-', ''))
    .filter(Boolean);

const line = (s = '') => console.log(s);
const h2 = (s: string) => {
  line();
  line('='.repeat(72));
  line(s);
  line('='.repeat(72));
};

await mkdir(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Session sanity. The favourites gallery is public and its URL contains the
// username, so the only trustworthy logged-in oracle is the /fav/ | /unfav/
// token on a submission page (report §3, trap 2).
// ---------------------------------------------------------------------------
h2('0. session sanity');
{
  const r = await get(`https://www.furaffinity.net/view/${cookies.samplePostId}/`);
  const hasToken = /\/(un)?fav\/\d+\/\?key=[0-9a-f]+/i.test(r.body);
  line(`  GET /view/${cookies.samplePostId}/ -> ${r.status}, ${r.bytes} bytes, ${r.ms} ms`);
  line(`  fav/unfav key token: ${hasToken ? 'present (session valid)' : 'absent (session dead)'}`);
  if (!hasToken) {
    line('  ABORT: refresh cookies.json before running the rest.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Point 3 — /scraps/ against /gallery/
// ---------------------------------------------------------------------------
h2('3. /scraps/ vs /gallery/');
const artists = (process.env.FA_ARTISTS ?? 'luxmori,blitzdrachin,ajin').split(',');
for (const artist of artists) {
  const gallery = await get(`https://www.furaffinity.net/gallery/${artist}/`);
  const galleryIds = ids(gallery.$);
  const scraps = await get(`https://www.furaffinity.net/scraps/${artist}/`);
  const scrapIds = ids(scraps.$);
  const overlap = scrapIds.filter((id) => galleryIds.includes(id));
  line(
    `  ${artist.padEnd(16)} gallery ${gallery.status}/${String(galleryIds.length).padStart(2)} tiles  ` +
      `scraps ${scraps.status}/${String(scrapIds.length).padStart(2)} tiles  overlap=${overlap.length}`
  );
}

// ---------------------------------------------------------------------------
// Point 4 — does walking /gallery/ reach everything a folder lists?
// Ids grow with time, so once the walk is below the folder's oldest id,
// anything still missing is genuinely absent from the main gallery.
// ---------------------------------------------------------------------------
h2('4. folder coverage by the paginated gallery');
{
  const artist = process.env.FA_FOLDER_ARTIST ?? 'blitzdrachin';
  const maxPages = Number(process.env.FA_GALLERY_PAGES ?? 30);

  const page1 = await get(`https://www.furaffinity.net/gallery/${artist}/`);
  const folders = [
    ...new Set(
      page1
        .$('a[href*="/folder/"]')
        .toArray()
        .map((el) => page1.$(el).attr('href') ?? '')
        .filter((href) => href.includes(`/gallery/${artist}/folder/`))
    )
  ];
  line(`  ${folders.length} folders advertised on gallery page 1`);
  const folderPath = process.env.FA_FOLDER ?? folders[0];
  if (!folderPath) {
    line('  no folders on this artist — skipping');
  } else {
    const folder = await get(`https://www.furaffinity.net${folderPath}`);
    const folderIds = new Set(ids(folder.$));
    const oldestInFolder = Math.min(...[...folderIds].map(Number));
    line(`  folder ${folderPath}: ${folderIds.size} submissions, oldest id ${oldestInFolder}`);

    const walked = new Set<string>(ids(page1.$));
    let covered = [...folderIds].filter((i) => walked.has(i)).length;
    for (let page = 2; page <= maxPages; page += 1) {
      const r = await get(`https://www.furaffinity.net/gallery/${artist}/${page}/`);
      const pageIds = ids(r.$);
      if (pageIds.length === 0) {
        line(`  page ${page}: empty — end of gallery`);
        break;
      }
      pageIds.forEach((i) => walked.add(i));
      covered = [...folderIds].filter((i) => walked.has(i)).length;
      const oldestOnPage = Math.min(...pageIds.map(Number));
      line(
        `  page ${String(page).padStart(2)}: cum=${String(walked.size).padStart(4)}  ` +
          `folder covered ${covered}/${folderIds.size}  oldest-on-page=${oldestOnPage}`
      );
      if (covered === folderIds.size) break;
      if (oldestOnPage < oldestInFolder) {
        const missing = [...folderIds].filter((i) => !walked.has(i));
        line(`  walked past the folder's oldest id; still missing: ${missing.join(',')}`);
        break;
      }
    }
    line(`  => ${covered}/${folderIds.size} folder submissions reachable by walking /gallery/`);
  }
}

// ---------------------------------------------------------------------------
// Point 5 — URL variants, and which hosts serve an authenticated submission
// ---------------------------------------------------------------------------
h2('5. URL variants for extractIdFromUrl');
{
  const id = cookies.samplePostId;
  const HOST_RE = /^(?:www\.|sfw\.)?furaffinity\.net$/i;
  const extractIdFromUrl = (raw: string): string | null => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (!HOST_RE.test(u.hostname)) return null;
    const m = /^\/(?:view|full)\/(\d+)\/?$/.exec(u.pathname);
    return m ? m[1] : null;
  };

  for (const v of [
    `https://www.furaffinity.net/view/${id}/`,
    `https://www.furaffinity.net/view/${id}`,
    `https://furaffinity.net/view/${id}/`,
    `http://www.furaffinity.net/view/${id}/`,
    `https://sfw.furaffinity.net/view/${id}/`,
    `https://www.furaffinity.net/full/${id}/`,
    `https://www.furaffinity.net/view/${id}/#cid:12345`,
    `https://xfuraffinity.net/view/${id}/`,
    `https://www.furaffinity.net/journal/${id}/`,
    `https://www.furaffinity.net/user/${id}/`
  ]) {
    line(`  ${(extractIdFromUrl(v) ?? '(null)').padEnd(10)} <- ${v}`);
  }

  line();
  line('  live: which hosts actually serve the submission, and with the session?');
  const bare = await get(`https://furaffinity.net/view/${id}/`, { redirect: 'manual' });
  line(`  bare host, redirect=manual -> ${bare.status} location=${bare.location ?? '-'}`);
  for (const [label, url, auth] of [
    ['www  auth', `https://www.furaffinity.net/view/${id}/`, true],
    ['www  anon', `https://www.furaffinity.net/view/${id}/`, false],
    ['bare auth', `https://furaffinity.net/view/${id}/`, true],
    ['sfw  auth', `https://sfw.furaffinity.net/view/${id}/`, true],
    ['full auth', `https://www.furaffinity.net/full/${id}/`, true]
  ] as const) {
    const r = await get(url, { auth });
    line(
      `  ${label}  ${r.status}  ${String(r.bytes).padStart(6)}b  loggedIn=${r.loggedIn}  ` +
        `img=${r.hasImg}  final=${r.finalUrl}`
    );
  }
}

// ---------------------------------------------------------------------------
// Point 6 — deep favourites pagination. The cursor lives in a form action,
// not an anchor.
// ---------------------------------------------------------------------------
h2('6. deep favourites pagination');
{
  const users = (process.env.FA_FAV_USERS ?? cookies.username).split(',');
  const maxPages = Number(process.env.FA_FAV_PAGES ?? 15);
  for (const user of users) {
    line();
    line(`--- /favorites/${user}/ ---`);
    let url = `https://www.furaffinity.net/favorites/${user}/`;
    const seen = new Set<string>();
    let page = 0;
    let slowest = 0;
    while (page < maxPages) {
      const r = await get(url);
      slowest = Math.max(slowest, r.ms);
      const pageIds = ids(r.$);
      const dupes = pageIds.filter((i) => seen.has(i)).length;
      pageIds.forEach((i) => seen.add(i));
      const next = r.$('form[action*="/next"]').attr('action') ?? '';
      page += 1;
      line(
        `  page ${String(page).padStart(2)}  ${r.status}  ${String(pageIds.length).padStart(2)} tiles  ` +
          `dup=${dupes}  cum=${String(seen.size).padStart(4)}  ${String(r.ms).padStart(4)}ms  ` +
          `next=${next || '(none)'}`
      );
      if (!next) break;
      url = `https://www.furaffinity.net${next}`;
    }
    line(`  ${seen.size} distinct ids over ${page} pages, slowest ${slowest}ms`);
  }
}

// ---------------------------------------------------------------------------
// Point 7 — what probeMatches can key on. detect.ts sends a JSON/XML Accept
// and no cookies, then falls back to raw text when the body is not JSON.
// ---------------------------------------------------------------------------
h2('7. autodetect markers');
{
  const detectHeaders = {
    'User-Agent': 'gooncave/1.0',
    Accept: 'application/json, application/xml;q=0.8, */*;q=0.5'
  };
  for (const p of ['/', '/browse/']) {
    const r = await get(`https://www.furaffinity.net${p}`, {
      auth: false,
      extraHeaders: detectHeaders
    });
    await writeFile(
      path.join(OUT_DIR, `verify-detect-${p === '/' ? 'home' : 'browse'}.html`),
      r.body
    );
    line(`  ${p}  ${r.status}  ${r.bytes}b`);
    line(`    <title>          ${r.$('title').first().text().trim().slice(0, 60)}`);
    line(`    meta description ${(r.$('meta[name="description"]').attr('content') ?? '(none)').slice(0, 60)}`);
    line(`    body id          ${r.$('body').attr('id') ?? '(none)'}`);
    line(`    figure[sid]      ${ids(r.$).length}`);
  }
}

line();
line(`done. ${requestCount} requests total.`);
