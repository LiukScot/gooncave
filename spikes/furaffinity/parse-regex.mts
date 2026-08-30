/**
 * Can the FA engine be written without cheerio? — gooncave issue #295.
 *
 * The backend has no HTML parser: gelbooru scrapes with `String.matchAll`
 * (gelbooru.ts:135), and AGENTS §6 says not to add a dependency for what a few
 * lines of stdlib do. This checks every field the engine needs, extracted by
 * regex, against cheerio as the oracle, on the HTML the spike already saved.
 *
 * A disagreement means the field genuinely needs a parser; agreement across
 * every saved page means the engine ships with zero new dependencies.
 */
import * as cheerio from 'cheerio';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');

// --- candidate implementation, regex only -----------------------------------

const listingIds = (html: string): string[] => [
  ...new Set([...html.matchAll(/<figure[^>]*\bid="sid-(\d+)"/g)].map((m) => m[1]))
];

type Tile = { id: string; rating: string | null; thumb: string | null; title: string | null; artist: string | null };

const FIGURE_OPEN = /<figure[^>]*\bid="sid-(\d+)"/;

/**
 * One listing tile. FA closes every figure and never nests them, so splitting
 * on </figure> is enough — but each chunk still carries whatever preceded its
 * <figure>, so it has to be trimmed to the tag or the page header leaks in.
 */
const parseListing = (html: string): Tile[] =>
  html
    .split('</figure>')
    .map((raw) => {
      const start = raw.search(FIGURE_OPEN);
      if (start === -1) return null;
      const chunk = raw.slice(start);
      const id = FIGURE_OPEN.exec(chunk)?.[1];
      if (!id) return null;
      const figureTag = /<figure[^>]*>/.exec(chunk)?.[0] ?? '';
      return {
        id,
        rating: /\br-(general|mature|adult)\b/.exec(figureTag)?.[1] ?? null,
        thumb: /<img[^>]*\bsrc="([^"]+)"/.exec(chunk)?.[1] ?? null,
        title: /<a[^>]*href="\/view\/\d+\/?"[^>]*>([^<]*)<\/a>/.exec(chunk)?.[1] ?? null,
        artist: /<a[^>]*href="\/user\/([^"/]+)/.exec(chunk)?.[1] ?? null
      };
    })
    .filter((t): t is Tile => t !== null);

const nextCursor = (html: string): string | null =>
  /<form[^>]*\baction="(\/favorites\/[^"/]+\/\d+\/next)"/.exec(html)?.[1] ?? null;

/** The submission image tag carries tags, full-res URL and the id in one go. */
const submissionImg = (html: string): string | null =>
  /<img[^>]*\bid="submissionImg"[^>]*>/.exec(html)?.[0] ?? null;

const attr = (tag: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

const favToken = (html: string): { action: 'fav' | 'unfav'; key: string } | null => {
  const m = /href="\/(fav|unfav)\/\d+\/\?key=([0-9a-f]+)"/i.exec(html);
  return m ? { action: m[1] as 'fav' | 'unfav', key: m[2] } : null;
};

/** On a submission page the rating is a c-contentRating--<level> class. */
const rating = (html: string): string | null =>
  /\bc-contentRating--(\w+)\b/.exec(html)?.[1]?.toLowerCase() ?? null;

/** A missing submission still answers 200; the image tag is what is absent. */
const submissionMissing = (html: string): boolean =>
  !/<img[^>]*\bid="submissionImg"/.test(html);

// --- cheerio oracle ----------------------------------------------------------

const oracle = (html: string) => {
  const $ = cheerio.load(html);
  const img = $('img#submissionImg');
  const favHref = $('a[href^="/fav/"]').attr('href') ?? $('a[href^="/unfav/"]').attr('href') ?? null;
  return {
    ids: [
      ...new Set(
        $('figure[id^="sid-"]')
          .toArray()
          .map((el) => ($(el).attr('id') ?? '').replace('sid-', ''))
      )
    ],
    tiles: $('figure[id^="sid-"]')
      .toArray()
      .map((el) => {
        const $f = $(el);
        const cls = $f.attr('class') ?? '';
        return {
          id: ($f.attr('id') ?? '').replace('sid-', ''),
          rating: /\br-(general|mature|adult)\b/.exec(cls)?.[1] ?? null,
          thumb: $f.find('img').first().attr('src') ?? null,
          artist: ($f.find('a[href^="/user/"]').first().attr('href') ?? '').split('/')[2] ?? null
        };
      }),
    rating: /\bc-contentRating--(\w+)\b/.exec($('.font-large.inline').attr('class') ?? '')?.[1] ?? null,
    cursor: $('form[action*="/next"]').attr('action') ?? null,
    tags: img.attr('data-tags') ?? null,
    fullview: img.attr('data-fullview-src') ?? null,
    favKey: favHref ? /key=([0-9a-f]+)/i.exec(favHref)?.[1] ?? null : null,
    hasImg: img.length > 0
  };
};

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let failures = 0;
const check = (file: string, field: string, mine: unknown, theirs: unknown) => {
  const ok = eq(mine, theirs);
  if (!ok) failures += 1;
  const show = (v: unknown) => {
    const s = Array.isArray(v) ? `[${v.length}] ${v.slice(0, 3).join(',')}` : String(v);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
  };
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${field.padEnd(10)} regex=${show(mine).padEnd(62)}` +
      (ok ? '' : ` cheerio=${show(theirs)}`)
  );
};

for (const file of (await readdir(OUT)).filter((f) => f.endsWith('.html')).sort()) {
  const html = await readFile(path.join(OUT, file), 'utf8');
  const o = oracle(html);
  console.log(`\n${file}  (${Math.round(html.length / 1024)} KB)`);

  check(file, 'ids', listingIds(html), o.ids);
  check(file, 'cursor', nextCursor(html), o.cursor);
  const tiles = parseListing(html);
  check(
    file,
    'tile.rating',
    tiles.map((t) => t.rating),
    o.tiles.map((t) => t.rating)
  );
  check(
    file,
    'tile.thumb',
    tiles.map((t) => t.thumb),
    o.tiles.map((t) => t.thumb)
  );
  check(
    file,
    'tile.artist',
    tiles.map((t) => t.artist),
    o.tiles.map((t) => t.artist)
  );

  const img = submissionImg(html);
  check(file, 'hasImg', img !== null, o.hasImg);
  if (img) {
    check(file, 'tags', attr(img, 'data-tags'), o.tags);
    check(file, 'fullview', attr(img, 'data-fullview-src'), o.fullview);
  }
  check(file, 'favKey', favToken(html)?.key ?? null, o.favKey);
  check(file, 'missing', submissionMissing(html), !o.hasImg);
  if (o.hasImg) check(file, 'rating', rating(html), o.rating);
}

console.log(
  failures === 0
    ? '\n=> every field matches cheerio. No parser dependency needed.'
    : `\n=> ${failures} disagreements — those fields need a real parser.`
);
process.exit(failures === 0 ? 0 : 1);
