/**
 * FurAffinity "follow artists" feasibility probe — gooncave issue #7, phase 2.
 *
 * Question: can we back a subscription/following feature with FA, the way we
 * can with a booru's `searchPosts`? Probes the three candidate sources:
 *
 *   1. /watchlist/by/<user>/   — who the user follows
 *   2. /msg/submissions/       — new submissions from watched artists (the
 *                                closest thing FA has to a subscription feed)
 *   3. /gallery/<artist>/      — one artist's submissions, for polling
 *
 * READ-ONLY. Never touches /msg/ removal endpoints — loading the inbox does
 * not clear it, but any "remove" link would.
 */
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const cookies = JSON.parse(await readFile(path.join(__dirname, 'cookies.json'), 'utf8'));

const headers = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Cookie: `a=${cookies.a}; b=${cookies.b}`
};

const get = async (url: string, saveAs: string) => {
  const res = await fetch(url, { headers });
  const html = await res.text();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, saveAs), html, 'utf8');
  console.log(`\n=== ${url}`);
  console.log(`  status ${res.status}, ${Buffer.byteLength(html)} bytes -> out/${saveAs}`);
  return cheerio.load(html);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Watchlist: who do we follow? ----
{
  const $ = await get(
    `https://www.furaffinity.net/watchlist/by/${cookies.username}/`,
    'watchlist.html'
  );
  const users = new Set<string>();
  $('a[href^="/user/"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/^\/user\/([^/]+)\/?$/);
    if (m) users.add(m[1]);
  });
  console.log(`  watched artists found: ${users.size}`);
  console.log(`  sample: ${[...users].slice(0, 8).join(', ')}`);
}
await sleep(2000);

// ---- 2. Submission inbox: new posts from watched artists ----
{
  const $ = await get('https://www.furaffinity.net/msg/submissions/', 'msg-submissions.html');
  const figures = $('figure[id^="sid-"]');
  console.log(`  new submissions in inbox: ${figures.length}`);
  figures.slice(0, 5).each((_, el) => {
    const f = $(el);
    const id = (f.attr('id') ?? '').replace(/^sid-/, '');
    const title = f.find('figcaption a').first().text().trim();
    const artist = f.find('figcaption a').eq(1).text().trim();
    console.log(`    - ${id} "${title}" by ${artist}`);
  });
  // Is there a "nothing new" marker instead?
  const empty = $('body').text().match(/no new submissions|nothing new/i);
  if (empty) console.log(`  (inbox appears empty: "${empty[0]}")`);
}
await sleep(2000);

// ---- 3. One artist's gallery: pollable per-artist feed ----
{
  const artist = process.argv[2] ?? 'luxmori';
  const $ = await get(`https://www.furaffinity.net/gallery/${artist}/`, `gallery-${artist}.html`);
  const figures = $('figure[id^="sid-"]');
  console.log(`  submissions on gallery page 1: ${figures.length}`);
  const ids = figures.map((_, el) => (($(el).attr('id') ?? '').replace(/^sid-/, ''))).get();
  console.log(`  newest ids: ${ids.slice(0, 5).join(', ')}`);
  console.log(`  ids monotonic desc? ${ids.every((v, i, a) => i === 0 || Number(a[i - 1]) >= Number(v))}`);
  // Pagination shape matters for "fetch until we hit last-seen id".
  const next = $('a[href*="/gallery/"]').filter((_, el) => /next/i.test($(el).text())).attr('href');
  console.log(`  next-page link: ${next ?? '(none found)'}`);
}
