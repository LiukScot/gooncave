/**
 * FurAffinity gap probe — gooncave issue #7, phase 4.
 *
 * Phases 1-3 proved the happy paths. This one attacks what an engine actually
 * breaks on:
 *
 *   1. favorites pagination — sync is worthless if we only ever see page 1.
 *      FA uses a CURSOR (/favorites/<user>/<favId>/next), not page numbers,
 *      and the cursor is a favourite-relation id, not a submission id.
 *   2. file download — the artwork lives on d.furaffinity.net, a DIFFERENT
 *      hostname from the site. Does it need the session cookie? A Referer?
 *      This matters because exploreDownloadHeaders() only attaches auth when
 *      the file host matches the site host, so FA downloads would go bare.
 *   3. logged-out shape — checkSessionCookie() needs to tell "cookies expired"
 *      apart from "page fetched fine".
 *   4. deleted / missing submission — engines must not treat a 404 page as
 *      an empty tag list.
 *
 * READ-ONLY. Downloads request only the first bytes via Range.
 */
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cookies = JSON.parse(await readFile(path.join(__dirname, 'cookies.json'), 'utf8'));

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const authed = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Cookie: `a=${cookies.a}; b=${cookies.b}`
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. Favorites pagination via cursor ----
{
  console.log('\n=== 1. favorites pagination (cursor)');
  let url = `https://www.furaffinity.net/favorites/${cookies.username}/`;
  const seen = new Set<string>();
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(url, { headers: authed });
    const html = await res.text();
    const $ = cheerio.load(html);
    const ids = $('figure[id^="sid-"]')
      .map((_, el) => ($(el).attr('id') ?? '').replace(/^sid-/, ''))
      .get();
    ids.forEach((i) => seen.add(i));
    const next = $('form[action*="/next"]').attr('action') ?? '';
    console.log(
      `  page ${page}: HTTP ${res.status}, ${ids.length} items, cumulative unique ${seen.size}`
    );
    console.log(`    next cursor: ${next || '(none — last page)'}`);
    if (!next) break;
    url = `https://www.furaffinity.net${next}`;
    await sleep(2000);
  }
}

// ---- 2. Downloading the artwork from d.furaffinity.net ----
{
  console.log('\n=== 2. file download from the CDN host');
  const fileUrl =
    'https://d.furaffinity.net/art/~peyote/1776200147/1776200147.~peyote_heaven_smol.png';
  const variants: Array<[string, Record<string, string>]> = [
    ['no cookie, no referer', { 'User-Agent': UA, Range: 'bytes=0-1023' }],
    ['cookie only', { 'User-Agent': UA, Range: 'bytes=0-1023', Cookie: authed.Cookie }],
    [
      'cookie + referer',
      {
        'User-Agent': UA,
        Range: 'bytes=0-1023',
        Cookie: authed.Cookie,
        Referer: 'https://www.furaffinity.net/'
      }
    ]
  ];
  for (const [label, headers] of variants) {
    const res = await fetch(fileUrl, { headers });
    const buf = Buffer.from(await res.arrayBuffer());
    const isPng = buf.subarray(1, 4).toString() === 'PNG';
    console.log(
      `  ${label.padEnd(22)} -> HTTP ${res.status}, ${buf.length}B, type=${res.headers.get('content-type')}, real PNG=${isPng}`
    );
    await sleep(1500);
  }
}

// ---- 3. What a logged-out response looks like ----
{
  console.log('\n=== 3. logged-out detection');
  const res = await fetch(`https://www.furaffinity.net/favorites/${cookies.username}/`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' } // deliberately no Cookie
  });
  const html = await res.text();
  const $ = cheerio.load(html);
  console.log(`  HTTP ${res.status}, ${Buffer.byteLength(html)} bytes`);
  console.log(`  figures present    : ${$('figure[id^="sid-"]').length}`);
  console.log(`  own /user/ link    : ${html.toLowerCase().includes(`/user/${cookies.username.toLowerCase()}/`)}`);
  console.log(`  has login form/link: ${/\/login/i.test(html)}`);
  const sysmsg = $('.section-body, .redirect-message').first().text().replace(/\s+/g, ' ').trim();
  console.log(`  system message     : ${sysmsg.slice(0, 120) || '(none)'}`);
}
await sleep(2000);

// ---- 4. A submission that does not exist ----
{
  console.log('\n=== 4. missing submission');
  const res = await fetch('https://www.furaffinity.net/view/1/', { headers: authed });
  const html = await res.text();
  const $ = cheerio.load(html);
  console.log(`  HTTP ${res.status}, ${Buffer.byteLength(html)} bytes`);
  console.log(`  submissionImg present: ${$('img#submissionImg').length > 0}`);
  const msg = $('.section-body').first().text().replace(/\s+/g, ' ').trim();
  console.log(`  message: ${msg.slice(0, 140) || '(none)'}`);
}
