/**
 * FurAffinity scraping feasibility probe — gooncave issue #7.
 *
 * Goal: determine empirically whether plain HTTP requests with session cookies
 * can reach FurAffinity's authenticated pages, or whether Cloudflare's bot
 * protection blocks us.
 *
 * This script does NOT touch the gooncave backend in any way. It's a one-off
 * diagnostic. See README.md for usage.
 */

import { fetch } from 'undici';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

interface Cookies {
  username: string;
  a: string;
  b: string;
  samplePostId: string;
}

interface ProbeResult {
  url: string;
  status: number;
  bytes: number;
  server: string | undefined;
  cfRay: string | undefined;
  hasCfBmCookie: boolean;
  bodySnippet: string;
  body: string;
}

/**
 * Build the headers we send to FurAffinity. We mimic a real browser as closely
 * as we reasonably can — Cloudflare also fingerprints things like header order
 * and TLS, but for an HTTP-only spike this is the best we can do.
 */
const buildHeaders = (cookies: Cookies): Record<string, string> => ({
  // A modern desktop UA. If FA's WAF blocks generic UAs, this is the most
  // common thing to tweak first.
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  Cookie: `a=${cookies.a}; b=${cookies.b}`
});

/**
 * Perform one GET request and return everything we care about for diagnosis.
 */
const probe = async (url: string, cookies: Cookies): Promise<ProbeResult> => {
  // fetch (not request) so gzip/br responses are decompressed for us.
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(cookies),
    redirect: 'follow'
  });
  const body = await res.text();
  return {
    url,
    status: res.status,
    bytes: Buffer.byteLength(body, 'utf8'),
    server: res.headers.get('server') ?? undefined,
    cfRay: res.headers.get('cf-ray') ?? undefined,
    hasCfBmCookie: (res.headers.getSetCookie?.() ?? []).some((c) =>
      c.includes('__cf_bm=')
    ),
    bodySnippet: body.slice(0, 200).replace(/\s+/g, ' ').trim(),
    body
  };
};

/**
 * Decide whether a probe result represents a Cloudflare block.
 *
 * TODO(human): implement this. This is the most important judgement call in
 * the spike — define what "blocked" means.
 *
 * Things you can inspect on the `result` object:
 *   - result.status                 (e.g. 200, 403, 503)
 *   - result.server                 (e.g. "cloudflare")
 *   - result.bodySnippet            (first 200 chars of HTML, whitespace-collapsed)
 *   - result.body                   (full HTML, if you want to grep it)
 *   - result.cfRay / result.hasCfBmCookie (Cloudflare is *always* in front of FA,
 *                                          so these are present even on success
 *                                          — they alone do NOT indicate a block)
 *
 * Markers that strongly suggest a Cloudflare *interstitial* (i.e. blocked):
 *   - HTTP status 403 or 503
 *   - body contains "Just a moment..." (the title of the JS challenge page)
 *   - body contains "cf-challenge" or "challenge-platform" or "/cdn-cgi/challenge-platform"
 *   - body is suspiciously small (< ~5 KB) AND status is not 200
 *
 * Return an object describing your verdict. Examples:
 *   { blocked: true,  reason: "HTTP 403 + Just a moment... interstitial" }
 *   { blocked: false, reason: "HTTP 200, body looks like real FA HTML" }
 *
 * Keep it simple — 5-10 lines is plenty. We can refine later if reality is messier.
 */
const detectCloudflareBlock = (
  result: ProbeResult
): { blocked: boolean; reason: string } => {
  // 1. Hard fail: anything in the 4xx/5xx range while served by Cloudflare
  //    is overwhelmingly a block (FA itself rarely returns 403/503 for a
  //    valid logged-in GET).
  if (result.status === 403 || result.status === 503) {
    return { blocked: true, reason: `HTTP ${result.status} from Cloudflare` };
  }
  // 2. Interstitial markers — these strings only appear on the JS challenge
  //    page, never in normal FA HTML. Checking the (whitespace-collapsed)
  //    snippet first is cheap; falling back to the full body catches cases
  //    where the marker is further down.
  const haystack = result.body.toLowerCase();
  if (haystack.includes('just a moment')) {
    return { blocked: true, reason: '"Just a moment..." challenge page' };
  }
  if (haystack.includes('/cdn-cgi/challenge-platform')) {
    return {
      blocked: true,
      reason: 'cdn-cgi/challenge-platform script present'
    };
  }
  // 3. Suspicious tininess: a real FA page is tens of KB. Anything under
  //    5 KB on a non-200 response is almost certainly a stub.
  if (result.status !== 200 && result.bytes < 5000) {
    return {
      blocked: true,
      reason: `HTTP ${result.status} with only ${result.bytes} bytes`
    };
  }
  // 4. Otherwise we trust it.
  return {
    blocked: false,
    reason: `HTTP ${result.status}, ${result.bytes} bytes of HTML`
  };
};

/**
 * Look for evidence that our session cookies actually authenticated us, by
 * checking whether the username appears in the navigation bar of the page.
 * FA renders the logged-in username inside the header on every page.
 */
const detectValidSession = (body: string, username: string): boolean => {
  // FA's logged-in header looks like: <a href="/user/<username>"...
  // We do a case-insensitive substring check to keep it forgiving.
  return body.toLowerCase().includes(`/user/${username.toLowerCase()}`);
};

const main = async () => {
  console.log('[probe] reading cookies.json...');
  const cookiesPath = path.join(__dirname, 'cookies.json');
  let cookies: Cookies;
  try {
    cookies = JSON.parse(await readFile(cookiesPath, 'utf8')) as Cookies;
  } catch (err) {
    console.error(
      '[probe] could not read cookies.json — copy cookies.example.json and fill it in'
    );
    console.error('[probe] details:', (err as Error).message);
    process.exit(1);
  }

  if (!cookies.a || !cookies.b || !cookies.username || !cookies.samplePostId) {
    console.error(
      '[probe] cookies.json is missing required fields (a, b, username, samplePostId)'
    );
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  // ---- Request 1: favorites page ----
  const favUrl = `https://www.furaffinity.net/favorites/${cookies.username}/`;
  console.log(`[probe] requesting ${favUrl}`);
  const favResult = await probe(favUrl, cookies);
  console.log(`[probe]   status: ${favResult.status}`);
  console.log(`[probe]   bytes: ${favResult.bytes}`);
  console.log(`[probe]   server: ${favResult.server ?? '(none)'}`);
  console.log(`[probe]   cf-ray: ${favResult.cfRay ?? '(none)'}`);
  console.log(
    `[probe]   set-cookie __cf_bm: ${favResult.hasCfBmCookie ? 'yes' : 'no'}`
  );
  console.log(`[probe]   body starts with: ${favResult.bodySnippet}`);

  const favHtmlPath = path.join(OUT_DIR, 'favorites-page1.html');
  await writeFile(favHtmlPath, favResult.body, 'utf8');
  console.log(
    `[probe]   saved -> ${path.relative(process.cwd(), favHtmlPath)}`
  );

  const favVerdict = detectCloudflareBlock(favResult);
  if (favVerdict.blocked) {
    console.log(`[probe] CLOUDFLARE: BLOCKED  (${favVerdict.reason})`);
    console.log(
      '[probe] aborting — no point fetching the post page if FA is unreachable.'
    );
    process.exit(2);
  }
  console.log(`[probe] CLOUDFLARE: PASSED  (${favVerdict.reason})`);

  const sessionOk = detectValidSession(favResult.body, cookies.username);
  console.log(
    `[probe]   session marker (${cookies.username} in header): ${sessionOk ? 'FOUND' : 'NOT FOUND'}`
  );
  if (!sessionOk) {
    console.log(
      '[probe]   warning: cookies may be expired — page loaded but you appear logged-out.'
    );
  }

  // ---- Request 2: a single post page ----
  const postUrl = `https://www.furaffinity.net/view/${cookies.samplePostId}/`;
  console.log(`[probe] requesting ${postUrl}`);
  const postResult = await probe(postUrl, cookies);
  console.log(`[probe]   status: ${postResult.status}`);
  console.log(`[probe]   bytes: ${postResult.bytes}`);

  const postHtmlPath = path.join(OUT_DIR, `view-${cookies.samplePostId}.html`);
  await writeFile(postHtmlPath, postResult.body, 'utf8');
  console.log(
    `[probe]   saved -> ${path.relative(process.cwd(), postHtmlPath)}`
  );

  const postVerdict = detectCloudflareBlock(postResult);
  console.log(
    `[probe]   verdict: ${postVerdict.blocked ? 'BLOCKED' : 'PASSED'}  (${postVerdict.reason})`
  );

  console.log('[probe] done. Run `npm run parse` next.');
};

main().catch((err) => {
  console.error('[probe] FAILED:', err);
  process.exit(1);
});
