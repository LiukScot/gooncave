/**
 * Point 2 — where is FurAffinity's rate limit? — gooncave issue #295.
 *
 * Every earlier probe used 1.5–2 s spacing, so the threshold was unmeasured.
 * This walks the spacing down a rung at a time and STOPS at the first sign of
 * trouble: a non-200, a Cloudflare interstitial, or a body that no longer
 * parses as a listing. It never runs requests in parallel.
 *
 * Targets cycle through the first PAGES gallery pages — distinct URLs, but
 * bounded, so the walk never runs off the end of the gallery and mistakes an
 * empty page for a block.
 */
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';

const c = JSON.parse(await readFile('./cookies.json', 'utf8')) as { a: string; b: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RUNGS = [2000, 1000, 500, 250];
const PER_RUNG = Number(process.env.FA_RUNG_SIZE ?? 15);
const ARTIST = process.env.FA_ARTIST ?? 'blitzdrachin';

const PAGES = Number(process.env.FA_PAGES ?? 12);
let issued = 0;
let aborted = false;

const probe = async () => {
  const url = `https://www.furaffinity.net/gallery/${ARTIST}/${(issued % PAGES) + 1}/`;
  issued += 1;
  const started = Date.now();
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      Cookie: `a=${c.a}; b=${c.b}`
    }
  });
  const body = await res.text();
  const $ = cheerio.load(body);
  return {
    status: res.status,
    ms: Date.now() - started,
    tiles: $('figure[id^="sid-"]').length,
    challenge: /Just a moment|challenge-platform|cf-error/i.test(body),
    retryAfter: res.headers.get('retry-after'),
    bytes: body.length,
    snippet: body.slice(0, 100).replace(/\s+/g, ' ')
  };
};

for (const spacing of RUNGS) {
  console.log(`\n--- ${PER_RUNG} sequential requests, ${spacing} ms apart ---`);
  const times: number[] = [];
  for (let i = 0; i < PER_RUNG; i += 1) {
    const r = await probe();
    times.push(r.ms);
    const bad = r.status !== 200 || r.challenge || r.tiles === 0;
    if (bad || i % 5 === 0 || i === PER_RUNG - 1) {
      console.log(
        `  #${String(i + 1).padStart(2)} ${r.status} ${String(r.ms).padStart(4)}ms ` +
          `tiles=${r.tiles} bytes=${r.bytes}` +
          (r.retryAfter ? ` retry-after=${r.retryAfter}` : '') +
          (r.challenge ? ' CHALLENGE' : '')
      );
    }
    if (bad) {
      console.log(`  !! limit hit at ${spacing} ms spacing, request ${i + 1}`);
      console.log(`  snippet: ${r.snippet}`);
      aborted = true;
      break;
    }
    if (i < PER_RUNG - 1) await sleep(spacing);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const max = Math.max(...times);
  console.log(`  ok: ${times.length} requests, avg ${avg} ms, max ${max} ms`);
  if (aborted) break;
}

console.log(
  aborted
    ? '\n=> threshold found (see above)'
    : `\n=> no limit reached down to ${RUNGS[RUNGS.length - 1]} ms spacing (${RUNGS.length * PER_RUNG} requests)`
);
