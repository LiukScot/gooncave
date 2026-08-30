/**
 * FurAffinity HTML parsing spike — gooncave issue #7.
 *
 * Reads the HTML files saved by probe.ts and tries to extract:
 *   - the favorites list (id, thumbUrl, title, artist) from favorites-page1.html
 *   - the tag list from view-<id>.html
 *
 * The CSS selectors below are educated guesses based on FA's "Beta" layout
 * (the modern one). If FA has redesigned since this was written, the
 * selectors will need to be updated by inspecting the saved HTML in `out/`.
 *
 * The whole point of this script is to fail loudly and tell us *what* needs
 * to be adjusted — it's a diagnostic, not production code.
 */

import * as cheerio from 'cheerio';
import { readFile } from 'node:fs/promises';
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

interface FavoriteEntry {
  id: string;
  thumbUrl: string;
  title: string;
  artist: string;
}

/**
 * Extract favorites from a FA favorites listing page.
 *
 * FA Beta layout: each submission lives in a `<figure id="sid-<id>">` element
 * inside `section.gallery`. The thumbnail is `figure b u s img` (FA's classic
 * obfuscated structure), the title and artist are in `figcaption`.
 *
 * If selectors fail, this returns an empty list and main() will warn.
 */
const parseFavorites = (html: string): FavoriteEntry[] => {
  const $ = cheerio.load(html);
  const entries: FavoriteEntry[] = [];

  $('figure[id^="sid-"]').each((_, el) => {
    const figure = $(el);
    const idAttr = figure.attr('id') ?? '';
    const id = idAttr.replace(/^sid-/, '');
    if (!id) return;

    const img = figure.find('img').first();
    let thumbUrl = img.attr('src') ?? img.attr('data-src') ?? '';
    if (thumbUrl.startsWith('//')) thumbUrl = `https:${thumbUrl}`;

    const title = figure.find('figcaption a').first().text().trim();
    // The artist link is usually the second <a> inside figcaption (the first
    // is the submission link, the second is the user link).
    const artist = figure.find('figcaption a').eq(1).text().trim();

    entries.push({ id, thumbUrl, title, artist });
  });

  return entries;
};

interface PostTags {
  tags: string[];
  category: string;
  theme: string;
  rating: string;
  species: string;
  artist: string;
  fullviewUrl: string;
}

/**
 * Extract tags + metadata from a FA post page.
 *
 * Everything except the rating comes from one attribute: `img#submissionImg`
 * carries `data-tags`, a space-separated list mixing prefixed metadata with
 * the artist's free-form keywords:
 *
 *   u__peyote c_artwork_digital t_all s_unspecified_any male sheath sweat hug
 *   ^artist   ^category         ^theme ^species         ^--- keywords ---^
 *
 * The `/search/@keywords` anchors carry the same keywords, but the attribute
 * is the better source: one lookup, and it survives layout changes.
 *
 * The rating is not in `data-tags` — it is rendered as a `Rating--<level>`
 * class elsewhere on the page.
 */
const parsePostTags = (html: string): PostTags => {
  const $ = cheerio.load(html);
  const img = $('img#submissionImg');

  const prefix = (p: string, all: string[]): string =>
    (all.find((t) => t.startsWith(p)) ?? '').slice(p.length);

  const dataTags = (img.attr('data-tags') ?? '').split(/\s+/).filter(Boolean);
  const isPrefixed = (t: string): boolean => /^[ucts]_/.test(t);

  let fullviewUrl = img.attr('data-fullview-src') ?? '';
  if (fullviewUrl.startsWith('//')) fullviewUrl = `https:${fullviewUrl}`;

  return {
    tags: Array.from(new Set(dataTags.filter((t) => !isPrefixed(t)))),
    category: prefix('c_', dataTags),
    theme: prefix('t_', dataTags),
    species: prefix('s_', dataTags),
    artist: prefix('u_', dataTags),
    rating: (html.match(/Rating--\w+">\s*(\w+)/) ?? [])[1] ?? '',
    fullviewUrl
  };
};

const main = async () => {
  const cookies = JSON.parse(
    await readFile(path.join(__dirname, 'cookies.json'), 'utf8')
  ) as Cookies;

  // ---- Parse favorites page ----
  const favPath = path.join(OUT_DIR, 'favorites-page1.html');
  console.log(`[parse] reading ${path.relative(process.cwd(), favPath)}`);
  let favHtml: string;
  try {
    favHtml = await readFile(favPath, 'utf8');
  } catch {
    console.error(
      '[parse] favorites HTML not found — run `npm run probe` first.'
    );
    process.exit(1);
  }

  const favorites = parseFavorites(favHtml);
  console.log(`[parse] extracted ${favorites.length} favorites`);
  if (favorites.length === 0) {
    console.warn(
      '[parse]   ⚠ zero favorites — selectors may be stale. Inspect favorites-page1.html.'
    );
  } else {
    console.log('[parse] first 5:');
    for (const fav of favorites.slice(0, 5)) {
      console.log(
        `        - id=${fav.id} title="${fav.title}" artist="${fav.artist}"`
      );
      console.log(`          thumb=${fav.thumbUrl}`);
    }
  }

  // ---- Parse single post ----
  const postPath = path.join(OUT_DIR, `view-${cookies.samplePostId}.html`);
  console.log(`[parse] reading ${path.relative(process.cwd(), postPath)}`);
  let postHtml: string;
  try {
    postHtml = await readFile(postPath, 'utf8');
  } catch {
    console.error('[parse] post HTML not found — run `npm run probe` first.');
    process.exit(1);
  }

  const postTags = parsePostTags(postHtml);
  console.log(
    `[parse] extracted ${postTags.tags.length} tags from post ${cookies.samplePostId}`
  );
  console.log(`[parse]   category: ${postTags.category || '(not found)'}`);
  console.log(`[parse]   theme:    ${postTags.theme || '(not found)'}`);
  console.log(`[parse]   rating:   ${postTags.rating || '(not found)'}`);
  console.log(`[parse]   species:  ${postTags.species || '(not found)'}`);
  console.log(`[parse]   artist:   ${postTags.artist || '(not found)'}`);
  console.log(`[parse]   fullview: ${postTags.fullviewUrl || '(not found)'}`);
  if (postTags.tags.length === 0) {
    console.warn(
      '[parse]   ⚠ zero tags — selectors may be stale. Inspect view-<id>.html.'
    );
  } else {
    console.log(
      `[parse]   tags: ${postTags.tags.slice(0, 20).join(', ')}${postTags.tags.length > 20 ? ', ...' : ''}`
    );
  }

  // ---- Verdict ----
  const ok = favorites.length > 0 && postTags.tags.length > 0;
  console.log(
    `[parse] VERDICT: ${ok ? 'PARSEABLE ✓' : 'NEEDS SELECTOR FIXES ✗'}`
  );
  process.exit(ok ? 0 : 3);
};

main().catch((err) => {
  console.error('[parse] FAILED:', err);
  process.exit(1);
});
