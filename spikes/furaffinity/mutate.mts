/**
 * Point 1 — execute a favourite and an unfavourite — gooncave issue #295.
 *
 * The only WRITE path in the spike, and the reason it stayed unrun: it mutates
 * a real account. Run it only with the account owner's consent. It is
 * net-zero — it favourites a submission that is currently not favourited, then
 * unfavourites it and verifies the account is back where it started.
 *
 * Answers:
 *   - does following /fav/<id>/?key=… actually favourite, and what does it
 *     return? (spoiler: a 302 that proves nothing)
 *   - is `key` per-submission, and is it stable across page loads?
 *   - is a key single-use? does a replay toggle the favourite back off?
 *   - does a wrong key fail loudly or silently?
 *   - how long does a captured key stay usable? (FA_KEY_AGE_MIN, 0 = skip)
 */
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cookies = JSON.parse(
  await readFile(path.join(__dirname, 'cookies.json'), 'utf8')
) as { username: string; a: string; b: string; samplePostId: string };

const KEY_AGE_MIN = Number(process.env.FA_KEY_AGE_MIN ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

const req = async (url: string, redirect: 'follow' | 'manual' = 'follow') => {
  if (n > 0) await sleep(2000);
  n += 1;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: `a=${cookies.a}; b=${cookies.b}`
    },
    redirect
  });
  return {
    status: res.status,
    location: res.headers.get('location'),
    body: await res.text()
  };
};

/** Favourite state and action token, both read off one submission page. */
const favState = async (id: string) => {
  const r = await req(`https://www.furaffinity.net/view/${id}/`);
  const $ = cheerio.load(r.body);
  const favHref = $('a[href^="/fav/"]').attr('href') ?? null;
  const unfavHref = $('a[href^="/unfav/"]').attr('href') ?? null;
  return {
    exists: $('img#submissionImg').length > 0,
    favourited: !!unfavHref,
    favHref,
    unfavHref,
    key: (/key=([0-9a-f]+)/i.exec(favHref ?? unfavHref ?? '') ?? [])[1] ?? null
  };
};

const line = (s = '') => console.log(s);

// ---------------------------------------------------------------------------
// target: an unfavourited submission off /browse/
// ---------------------------------------------------------------------------
line('--- picking an unfavourited target from /browse/ ---');
const browse = await req('https://www.furaffinity.net/browse/');
const $browse = cheerio.load(browse.body);
const candidates = $browse('figure[id^="sid-"]')
  .toArray()
  .map((el) => ($browse(el).attr('id') ?? '').replace('sid-', ''))
  .filter(Boolean)
  .slice(0, 6);

let target: string | null = null;
let initial: Awaited<ReturnType<typeof favState>> | null = null;
for (const id of candidates) {
  const s = await favState(id);
  line(`  ${id}: exists=${s.exists} favourited=${s.favourited}`);
  if (s.exists && !s.favourited) {
    target = id;
    initial = s;
    break;
  }
}
if (!target || !initial?.favHref) {
  line('no unfavourited candidate found — aborting');
  process.exit(1);
}
line(`  target: ${target}`);

// ---------------------------------------------------------------------------
// key scope: same submission twice, then a different submission
// ---------------------------------------------------------------------------
line();
line('--- key scope and stability ---');
const reread = await favState(target);
const other = await favState(cookies.samplePostId);
line(`  ${target} load 1: ${initial.key}`);
line(`  ${target} load 2: ${reread.key}`);
line(`  stable across loads of the same submission: ${initial.key === reread.key}`);
line(`  ${cookies.samplePostId} differs from ${target}: ${other.key !== initial.key}`);

// ---------------------------------------------------------------------------
// wrong key
// ---------------------------------------------------------------------------
line();
line('--- wrong key ---');
const bogus = await req(`https://www.furaffinity.net/fav/${target}/?key=${'0'.repeat(64)}`, 'manual');
line(`  GET /fav/${target}/?key=000… -> ${bogus.status} location=${bogus.location ?? '-'} bytes=${bogus.body.length}`);
line(`  favourited after bogus key: ${(await favState(target)).favourited} (must be false)`);

// ---------------------------------------------------------------------------
// key age: let the captured key sit before spending it
// ---------------------------------------------------------------------------
if (KEY_AGE_MIN > 0) {
  line();
  line(`--- ageing the captured key ${KEY_AGE_MIN} min before spending it ---`);
  await sleep(KEY_AGE_MIN * 60_000);
}

// ---------------------------------------------------------------------------
// FAV
// ---------------------------------------------------------------------------
line();
line('--- executing FAV ---');
const favRes = await req(`https://www.furaffinity.net${initial.favHref}`, 'manual');
line(`  GET ${initial.favHref}`);
line(`  -> ${favRes.status} location=${favRes.location ?? '-'} bytes=${favRes.body.length}`);
const afterFav = await favState(target);
line(`  re-read: favourited=${afterFav.favourited}` + (KEY_AGE_MIN > 0 ? `  (key was ${KEY_AGE_MIN} min old)` : ''));

// ---------------------------------------------------------------------------
// replay the spent key
// ---------------------------------------------------------------------------
line();
line('--- replaying the spent fav key ---');
const replay = await req(`https://www.furaffinity.net${initial.favHref}`, 'manual');
line(`  -> ${replay.status} location=${replay.location ?? '-'}`);
const afterReplay = await favState(target);
line(`  still favourited: ${afterReplay.favourited} (a replay must not toggle it off)`);

// ---------------------------------------------------------------------------
// UNFAV — restore
// ---------------------------------------------------------------------------
line();
line('--- executing UNFAV (restore) ---');
if (!afterReplay.unfavHref) {
  line(`  no /unfav/ link — MANUAL CLEANUP NEEDED for submission ${target}`);
  process.exit(1);
}
const unfavRes = await req(`https://www.furaffinity.net${afterReplay.unfavHref}`, 'manual');
line(`  GET ${afterReplay.unfavHref}`);
line(`  -> ${unfavRes.status} location=${unfavRes.location ?? '-'}`);
const restored = await favState(target);
line(`  re-read: favourited=${restored.favourited} (must be false)`);
line();
line(
  restored.favourited
    ? `!! ACCOUNT NOT RESTORED — unfavourite ${target} manually`
    : `account restored: ${target} is back to unfavourited`
);
line(`${n} requests.`);
