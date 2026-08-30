/**
 * FurAffinity follow/unfollow probe — gooncave issue #7 / #293.
 *
 * Question: can gooncave follow and unfollow an artist on FA, or is the
 * watchlist read-only from our side? Mirrors the favourite probe: check which
 * of /watch/ or /unwatch/ the user page renders, and whether it carries a
 * session token.
 *
 * STRICTLY READ-ONLY. Following either link would change who the account
 * follows, and would show up in another user's follower count.
 */
import { fetch } from 'undici';
import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cookies = JSON.parse(
  await readFile(path.join(__dirname, 'cookies.json'), 'utf8')
);

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const load = async (url: string, withCookies = true) => {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'text/html' };
  if (withCookies) headers.Cookie = `a=${cookies.a}; b=${cookies.b}`;
  const res = await fetch(url, { headers });
  const html = await res.text();
  return { status: res.status, html, $: cheerio.load(html) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pick the first name from out/watchlist.html, not from the favourites page:
// favouriting a post does not mean you follow its artist, and testing with a
// merely-favourited artist reads as "not followed" and looks like a bug.
for (const [label, user] of [
  ['already followed', 'anakonda7'],
  ['not followed', 'luxmori']
] as const) {
  const { status, html, $ } = await load(`https://www.furaffinity.net/user/${user}/`);
  const watch = html.match(/\/watch\/[^"'?]+\?key=([a-z0-9]+)/i);
  const unwatch = html.match(/\/unwatch\/[^"'?]+\?key=([a-z0-9]+)/i);
  const btn = $('a')
    .filter((_, e) => /(^|\s)(\+Watch|-Unwatch|Watch|Unwatch)(\s|$)/i.test($(e).text().trim()))
    .first()
    .text()
    .trim();
  console.log(`\n--- /user/${user}/ (${label}) :: HTTP ${status}`);
  console.log(`  /watch/   link : ${watch ? `yes (token ${watch[1].length} chars)` : 'no'}`);
  console.log(`  /unwatch/ link : ${unwatch ? `yes (token ${unwatch[1].length} chars)` : 'no'}`);
  console.log(`  button text    : ${btn || '(none)'}`);
  console.log(`  => state       : ${unwatch ? 'FOLLOWED' : watch ? 'not followed' : 'UNKNOWN'}`);
  await sleep(2000);
}

// Without cookies the action links must vanish, same as fav/unfav.
{
  const { html } = await load('https://www.furaffinity.net/user/anakonda7/', false);
  const any = /\/(un)?watch\/[^"'?]+\?key=[a-z0-9]+/i.test(html);
  console.log(`\n--- logged out :: watch/unwatch token present: ${any}`);
}
