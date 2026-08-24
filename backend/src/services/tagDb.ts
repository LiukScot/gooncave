import { gunzipSync } from 'zlib';

import { fetch } from 'undici';

import { config } from '../config';
import { tagDbRepo } from '../db/repos/tagDbRepo';
import { normalizeTag } from '../lib/booruEngines/helpers';
import {
  buildImplicationClosure,
  isUnusableConsequent,
  resolveAlias
} from '../lib/tagAliases';

const EXPORT_BASE = 'https://static1.e621.net/data/db_export';

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
export const parseCsvRows = (text: string): string[][] => {
  const rows: string[][] = [];
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
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

/** Turns the export's rows into records keyed by its header line. */
export const rowsToRecords = (rows: string[][]): Record<string, string>[] => {
  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((row) => row.length >= header.length)
    .map((row) =>
      Object.fromEntries(header.map((name, index) => [name, row[index] ?? '']))
    );
};

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

// Stored tags went through `normalizeTag` on the way in, and so does every
// search term, so the export is normalised the same way.
export const parseAliasExport = (
  csv: string
): { antecedent: string; consequent: string }[] =>
  rowsToRecords(parseCsvRows(csv))
    .filter((row) => row.status === 'active')
    .filter((row) => !isUnusableConsequent(row.consequent_name ?? ''))
    .filter((row) => !isAmbiguousAfterNormalising(row.antecedent_name ?? ''))
    .map((row) => ({
      antecedent: normalizeTag(row.antecedent_name ?? ''),
      consequent: normalizeTag(row.consequent_name ?? '')
    }))
    .filter((row) => row.antecedent && row.consequent)
    .filter((row) => row.antecedent !== row.consequent);

export const parseImplicationExport = (
  csv: string
): Map<string, Set<string>> => {
  const direct = new Map<string, Set<string>>();
  for (const row of rowsToRecords(parseCsvRows(csv))) {
    if (row.status !== 'active') continue;
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
 * True when `consequent` already resolves back to `antecedent`, which would
 * make the pair a loop. `resolveAlias` breaks loops by stopping, so the two
 * tags would settle on each other instead of collapsing onto one, and
 * search would disagree with itself depending on which one was typed.
 */
export const wouldCycle = (antecedent: string, consequent: string): boolean => {
  if (antecedent === consequent) return true;
  const aliases = new Map(tagDbRepo.aliasLookup());
  aliases.delete(antecedent);
  return resolveAlias(consequent, aliases) === antecedent;
};

/**
 * Adds or replaces one of the user's own aliases and re-derives the library
 * so the change shows up in search straight away.
 */
export const setCustomAlias = (antecedent: string, consequent: string) => {
  tagDbRepo.upsertCustomAlias(antecedent, consequent);
  recanonicaliseAll();
};

export const dropCustomAlias = (antecedent: string): number => {
  const removed = tagDbRepo.removeCustomAlias(antecedent);
  if (removed > 0) recanonicaliseAll();
  return removed;
};

export const tagDatabaseStatus = () => ({
  importedAt: tagDbRepo.getMeta(TAG_DB_META_KEYS.importedAt),
  aliases: tagDbRepo.countRows('tag_aliases'),
  implications: tagDbRepo.countRows('tag_implications'),
  customAliases: tagDbRepo.listCustomAliases().length
});

/** Re-derives `canonical_tag` for every stored tag from the current table. */
export const recanonicaliseAll = () => {
  invalidateAliasCache();
  tagDbRepo.recanonicaliseFileTags(canonicalResolver());
};

export type TagDbImportResult = {
  aliases: number;
  implications: number;
};

// One import at a time: it rewrites both tables wholesale, and two runs
// racing would leave the second deleting rows the first is still inserting.
// Callers share the in-flight run rather than queueing behind it.
let inFlight: Promise<TagDbImportResult> | null = null;

/**
 * Pulls the current e621 export and rebuilds the alias and implication
 * tables from it, then re-canonicalises the library so existing files pick
 * the new mapping up. Custom aliases are left alone.
 */
export const importTagDatabase = (): Promise<TagDbImportResult> => {
  inFlight ??= runImport().finally(() => {
    inFlight = null;
  });
  return inFlight;
};

const runImport = async (): Promise<TagDbImportResult> => {
  const [aliasCsv, implicationCsv] = await Promise.all([
    download('tag_aliases'),
    download('tag_implications')
  ]);

  tagDbRepo.replaceImportedAliases(parseAliasExport(aliasCsv));
  tagDbRepo.replaceImplications(
    buildImplicationClosure(parseImplicationExport(implicationCsv))
  );
  recanonicaliseAll();

  tagDbRepo.setMeta(TAG_DB_META_KEYS.importedAt, new Date().toISOString());
  tagDbRepo.setMeta(TAG_DB_META_KEYS.importedFrom, EXPORT_BASE);

  return {
    aliases: tagDbRepo.countRows('tag_aliases'),
    implications: tagDbRepo.countRows('tag_implications')
  };
};
