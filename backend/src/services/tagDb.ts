import { gunzipSync } from 'zlib';

import { fetch } from 'undici';
import { z } from 'zod';

import { config } from '../config';
import { tagDbRepo } from '../db/repos/tagDbRepo';
import { normalizeTag } from '../lib/booruEngines/helpers';
import {
  buildImplicationClosure,
  isUnusableConsequent,
  resolveAlias
} from '../lib/tagAliases';

const EXPORT_BASE = 'https://static1.e621.net/data/db_export';

/**
 * Danbooru withdrew its CSV dumps in 2022, so its half of the vocabulary
 * comes off the live API instead. It answers unauthenticated, names its
 * fields exactly as the e621 export does, and hands over the whole active
 * set in ~90 cursor pages.
 */
const DANBOORU_API = 'https://danbooru.donmai.us';
// Named for the env var it comes from; every engine sends it to its own
// site the same way (see booruEngines/danbooru.ts).
const userAgent = () => config.e621.userAgent;
const DANBOORU_PAGE_SIZE = 1000;

/** e621's numeric tag categories, under the names this app stores. */
const E621_CATEGORIES: Record<string, string> = {
  '0': 'general',
  '1': 'artist',
  '3': 'copyright',
  '4': 'character',
  '5': 'species',
  '6': 'invalid',
  '7': 'meta',
  '8': 'lore'
};

export type AliasPair = { antecedent: string; consequent: string };

export const TAG_DB_META_KEYS = {
  importedAt: 'imported_at',
  importedFrom: 'imported_from'
} as const;

/**
 * Minimal RFC4180 reader. The exports quote their `reason` column, which
 * carries commas and newlines, so splitting on commas mangles every row
 * after the first quoted one. Only the header plus the handful of columns
 * this module reads are needed, but the whole row has to be walked to know
 * where it ends.
 */
export function* readCsvRows(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Close the row on the first character of the break and skip the \n of
      // a \r\n pair; a bare \r\n would otherwise emit an empty row.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      yield row;
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    yield row;
  }
}

/**
 * The export's rows as records keyed by its header line.
 *
 * Yielded one at a time: the `tags` export is 1.6M rows, and holding the
 * split rows and the records for all of them at once costs gigabytes for a
 * walk that only ever looks at one row.
 */
export function* readCsvRecords(
  text: string
): Generator<Record<string, string>> {
  let header: string[] | null = null;
  for (const row of readCsvRows(text)) {
    if (!header) {
      header = row;
      continue;
    }
    if (row.length < header.length) continue;
    yield Object.fromEntries(
      header.map((name, index) => [name, row[index] ?? ''])
    );
  }
}

const download = async (name: string): Promise<string> => {
  const response = await fetch(`${EXPORT_BASE}/${name}.csv.gz`, {
    headers: { 'User-Agent': config.e621.userAgent }
  });
  if (!response.ok) {
    throw new Error(`tag-db: ${name} export returned HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  return gunzipSync(body).toString('utf8');
};

const danbooruRows = z.array(
  z.object({
    id: z.number(),
    antecedent_name: z.string(),
    consequent_name: z.string()
  })
);

/**
 * Every active row of one Danbooru relation table.
 *
 * Paged by cursor rather than page number: `page=b<id>` walks ids downwards
 * and has no depth limit, while numbered pages stop at 1000. `only=` keeps
 * the payload to the three fields used here.
 */
const downloadDanbooru = async (
  relation: 'tag_aliases' | 'tag_implications'
): Promise<PairRow[]> => {
  const rows: PairRow[] = [];
  let cursor: number | null = null;

  for (;;) {
    const url = new URL(`/${relation}.json`, DANBOORU_API);
    url.searchParams.set('limit', String(DANBOORU_PAGE_SIZE));
    url.searchParams.set('search[status]', 'active');
    url.searchParams.set('only', 'id,antecedent_name,consequent_name');
    if (cursor !== null) url.searchParams.set('page', `b${cursor}`);

    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent() }
    });
    if (!response.ok) {
      throw new Error(
        `tag-db: danbooru ${relation} returned HTTP ${response.status}`
      );
    }
    const page = danbooruRows.parse(await response.json());
    if (page.length === 0) return rows;
    rows.push(...page);

    if (page.length < DANBOORU_PAGE_SIZE) return rows;

    // Cursor pages walk ids downwards. One that stops moving would page
    // forever, and returning the rows collected so far would rebuild both
    // tables from a partial set and re-canonicalise the library onto it.
    const next = page[page.length - 1]!.id;
    if (cursor !== null && next >= cursor) {
      throw new Error(`tag-db: danbooru ${relation} cursor did not advance`);
    }
    cursor = next;
  }
};

/**
 * True when normalising a tag name changes it, which means the stored form
 * cannot be told apart from a different tag that already spells itself that
 * way. e621 has `female/?` and `?/female`, and both normalise to `female` —
 * honouring them would redirect the library's most common tag to
 * `female/ambiguous`. Such a row is dropped rather than guessed at.
 *
 * Only the antecedent is held to this: it has to match a stored tag exactly.
 * A consequent is just a name, and normalising it is what makes
 * `straight → male/female` land on the `malefemale` files really carry.
 */
const isAmbiguousAfterNormalising = (raw: string): boolean =>
  normalizeTag(raw) !== raw;

type PairRow = { antecedent_name?: string; consequent_name?: string };

function* activeRows(csv: string): Generator<Record<string, string>> {
  for (const row of readCsvRecords(csv)) {
    if (row.status === 'active') yield row;
  }
}

// Stored tags went through `normalizeTag` on the way in, and so does every
// search term, so every source is normalised the same way.
export const aliasPairs = (rows: Iterable<PairRow>): AliasPair[] =>
  [...rows]
    .filter((row) => !isUnusableConsequent(row.consequent_name ?? ''))
    .filter((row) => !isAmbiguousAfterNormalising(row.antecedent_name ?? ''))
    .map((row) => ({
      antecedent: normalizeTag(row.antecedent_name ?? ''),
      consequent: normalizeTag(row.consequent_name ?? '')
    }))
    .filter((row) => row.antecedent && row.consequent)
    .filter((row) => row.antecedent !== row.consequent);

export const parseAliasExport = (csv: string): AliasPair[] =>
  aliasPairs(activeRows(csv));

/**
 * The Danbooru rows that would fight the e621 table, dropped.
 *
 * The two sites disagree about which name is canonical — e621 sends `ass`
 * to `butt`, Danbooru sends `butt` to `ass` — and 419 such pairs form a
 * two-step cycle. `resolveAlias` survives a cycle by returning the tag it
 * started from, and that is the damage: `ass` and `butt` would stop
 * collapsing together, so searching one would no longer find the other.
 *
 * A Danbooru row is kept only when its antecedent is neither an e621
 * antecedent nor an e621 consequent. Each table is acyclic on its own, so a
 * cycle in the union has to leave an e621 node through a Danbooru edge — and
 * every kept Danbooru edge starts outside the e621 names entirely, so there
 * is no such edge. Measured against the live tables: 38,042 of 41,021 rows
 * kept, no cycles.
 */
export const danbooruAliasesToKeep = (
  e621: AliasPair[],
  danbooru: AliasPair[]
): AliasPair[] => {
  const claimed = new Set(
    e621.flatMap((row) => [row.antecedent, row.consequent])
  );
  return danbooru.filter((row) => !claimed.has(row.antecedent));
};

export const implicationPairs = (
  rows: Iterable<PairRow>
): Map<string, Set<string>> => {
  const direct = new Map<string, Set<string>>();
  for (const row of rows) {
    if (isAmbiguousAfterNormalising(row.antecedent_name ?? '')) continue;
    const tag = normalizeTag(row.antecedent_name ?? '');
    const parent = normalizeTag(row.consequent_name ?? '');
    if (!tag || !parent || tag === parent) continue;
    const parents = direct.get(tag) ?? new Set<string>();
    parents.add(parent);
    direct.set(tag, parents);
  }
  return direct;
};

export const parseImplicationExport = (csv: string): Map<string, Set<string>> =>
  implicationPairs(activeRows(csv));

/**
 * The tag -> category map, out of the export's `tags` table.
 *
 * Only rows that say something useful are kept:
 *
 * - 'general' is the default every write path already uses, so storing it
 *   would change nothing;
 * - 'invalid' is e621's bin for words it refuses as tags — `thighs`,
 *   `mouth`, `brown`, `furry`. They are ordinary tags in a local library,
 *   mostly straight out of the tagger, and filing them under a category
 *   that reads as broken is worse than leaving them general;
 * - tags no post carries are 735k dead names and typos that would double
 *   the table without ever matching a stored tag.
 */
export const parseTagCategoryExport = (
  csv: string
): { tag: string; category: string }[] => {
  const entries: { tag: string; category: string }[] = [];
  for (const row of readCsvRecords(csv)) {
    if (Number(row.post_count ?? '0') <= 0) continue;
    if (isAmbiguousAfterNormalising(row.name ?? '')) continue;
    const category = E621_CATEGORIES[row.category ?? ''] ?? 'general';
    if (category === 'general' || category === 'invalid') continue;
    const tag = normalizeTag(row.name ?? '');
    if (tag) entries.push({ tag, category });
  }
  return entries;
};

// The alias table is ~66k rows and every stored tag has to be resolved
// against it, so it is read once and kept until something changes it.
// Invalidated by the import and by every alias edit.
let aliasCache: Map<string, string> | null = null;

export const invalidateAliasCache = () => {
  aliasCache = null;
};

/**
 * The mapping used by both the write path and the search path, so a tag and
 * the term searched for it always collapse the same way.
 */
export const canonicalResolver = (): ((tag: string) => string) => {
  const aliases = (aliasCache ??= tagDbRepo.aliasLookup());
  return (tag: string) => resolveAlias(tag, aliases);
};

export const canonicalTag = (tag: string): string => canonicalResolver()(tag);

/**
 * The category the import knows for a tag, or null. Read straight from
 * SQLite on every call: unlike the alias map this only serves the write
 * path, where a handful of indexed lookups per file cost less than holding
 * 700k rows in memory for the lifetime of the process.
 */
export const importedCategory = (tag: string): string | null =>
  tagDbRepo.categoryForTag(tag);

/** Re-derives `canonical_tag` for every stored tag from the current table. */
export const recanonicaliseAll = () => {
  invalidateAliasCache();
  tagDbRepo.recanonicaliseFileTags(canonicalResolver());
};

export type TagDbImportResult = {
  aliases: number;
  implications: number;
  categories: number;
  recategorised: number;
};

// One import at a time: it rewrites both tables wholesale, and two runs
// racing would leave the second deleting rows the first is still inserting.
// Callers share the in-flight run rather than queueing behind it.
let inFlight: Promise<TagDbImportResult> | null = null;

/**
 * Pulls the current e621 export and the Danbooru relation tables, rebuilds
 * the alias, implication and category tables from both, then re-canonicalises
 * the library so existing files pick the new mapping up. Custom aliases are
 * left alone.
 */
export const importTagDatabase = (): Promise<TagDbImportResult> => {
  inFlight ??= runImport().finally(() => {
    inFlight = null;
  });
  return inFlight;
};

const runImport = async (): Promise<TagDbImportResult> => {
  // One failure fails the lot. The tables are rewritten wholesale, so
  // importing with a source missing would re-canonicalise the whole library
  // onto a different mapping and put it back on the next run — the library's
  // tags would flip on every hiccup at either site. A skipped refresh leaves
  // the previous tables in place instead, which the worker already expects.
  const [
    aliasCsv,
    implicationCsv,
    tagCsv,
    danbooruAliases,
    danbooruImplications
  ] = await Promise.all([
    download('tag_aliases'),
    download('tag_implications'),
    download('tags'),
    downloadDanbooru('tag_aliases'),
    downloadDanbooru('tag_implications')
  ]);

  const e621Aliases = parseAliasExport(aliasCsv);
  tagDbRepo.replaceImportedAliases([
    ...e621Aliases.map((pair) => ({ ...pair, source: 'e621' as const })),
    ...danbooruAliasesToKeep(e621Aliases, aliasPairs(danbooruAliases)).map(
      (pair) => ({ ...pair, source: 'danbooru' as const })
    )
  ]);

  // Both sources go into the closure together: a chain that crosses
  // vocabularies (`husky` from Danbooru, `canine` from e621) only resolves
  // when the walk can see every edge at once.
  const implications = parseImplicationExport(implicationCsv);
  for (const [tag, parents] of implicationPairs(danbooruImplications)) {
    const merged = implications.get(tag) ?? new Set<string>();
    for (const parent of parents) merged.add(parent);
    implications.set(tag, merged);
  }
  tagDbRepo.replaceImplications(buildImplicationClosure(implications));

  tagDbRepo.replaceTagCategories(parseTagCategoryExport(tagCsv));
  const recategorised = tagDbRepo.recategoriseFileTags();
  recanonicaliseAll();

  tagDbRepo.setMeta(TAG_DB_META_KEYS.importedAt, new Date().toISOString());
  tagDbRepo.setMeta(
    TAG_DB_META_KEYS.importedFrom,
    [EXPORT_BASE, DANBOORU_API].join(' ')
  );

  return {
    aliases: tagDbRepo.countRows('tag_aliases'),
    implications: tagDbRepo.countRows('tag_implications'),
    categories: tagDbRepo.countRows('tag_categories'),
    recategorised
  };
};
