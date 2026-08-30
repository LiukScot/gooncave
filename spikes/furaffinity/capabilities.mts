/**
 * FurAffinity capability probe — gooncave issue #7, phase 3.
 *
 * Answers two questions the engine capability matrix needs:
 *
 *   1. favorites: is remote add/remove reachable, and can we tell current
 *      state without acting? Verified READ-ONLY — we look at which of
 *      /fav/ or /unfav/ the page renders, never follow either link.
 *   2. search: does FA expose anything score-like to sort by?
 *
 * STRICTLY READ-ONLY. Following a /fav/ or /unfav/ link would mutate the
 * user's real account.
 */
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cookies = JSON.parse(await readFile(path.join(__dirname, 'cookies.json'), 'utf8'));

const headers = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: `a=${cookies.a}; b=${cookies.b}`
};

const load = async (url: string) => {
  const res = await fetch(url, { headers });
  const html = await res.text();
  return { $: cheerio.load(html), html, status: res.status };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Favorite state detection, without acting ----
// Two posts: one known-favorited, one from a gallery that should not be.
for (const [label, id] of [
  ['known favorited', '64670793'],
  ['likely NOT favorited', '66088503']
] as const) {
  const { $, html, status } = await load(`https://www.furaffinity.net/view/${id}/`);
  const fav = html.match(/\/fav\/(\d+)\/?\?key=([a-z0-9]+)/i);
  const unfav = html.match(/\/unfav\/(\d+)\/?\?key=([a-z0-9]+)/i);
  const label2 = $('a:contains("Add to Favorites"), a:contains("Remove from Favorites")')
    .first()
    .text()
    .trim();
  console.log(`\n--- ${id} (${label}) :: HTTP ${status}`);
  console.log(`  /fav/   link present : ${fav ? `yes (token ${fav[2].length} chars)` : 'no'}`);
  console.log(`  /unfav/ link present : ${unfav ? `yes (token ${unfav[2].length} chars)` : 'no'}`);
  console.log(`  button text          : ${label2 || '(not found)'}`);
  console.log(`  => inferred state    : ${unfav ? 'FAVORITED' : fav ? 'not favorited' : 'UNKNOWN'}`);
  await sleep(2000);
}

// ---- 2. Search: any score-like sort? ----
{
  const { $, html, status } = await load('https://www.furaffinity.net/search/?q=wolf');
  console.log(`\n--- /search/ :: HTTP ${status}`);
  const opts = $('select[name="order-by"] option, input[name="order-by"]')
    .map((_, e) => $(e).attr('value') ?? $(e).text().trim())
    .get();
  console.log(`  order-by options : ${opts.join(', ') || '(none found)'}`);
  const ranges = $('select[name="range"] option')
    .map((_, e) => $(e).attr('value'))
    .get();
  console.log(`  range options    : ${ranges.join(', ') || '(none found)'}`);
  console.log(`  results on page  : ${$('figure[id^="sid-"]').length}`);
  // Does any listing expose a numeric score / fav count / view count?
  for (const needle of ['score', 'favorites:', 'views:', 'data-score']) {
    console.log(`  mentions "${needle}" : ${html.toLowerCase().includes(needle) ? 'yes' : 'no'}`);
  }
}
await sleep(2000);

// ---- 3. Does a post page expose fav/view counts we could sort on locally? ----
{
  const { $, html } = await load('https://www.furaffinity.net/view/64670793/');
  const stats = $('.stats-container, .submission-sidebar .stats').text().replace(/\s+/g, ' ').trim();
  console.log(`\n--- post stats block`);
  console.log(`  ${stats.slice(0, 200) || '(not found via .stats-container)'}`);
  for (const needle of ['Favorites', 'Views', 'Comments']) {
    const m = html.match(new RegExp(`${needle}[^0-9]{0,40}(\\d[\\d,]*)`, 'i'));
    console.log(`  ${needle}: ${m ? m[1] : '(not found)'}`);
  }
}
