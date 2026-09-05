import { sqlite } from '../client';

export type TagAliasSource = 'e621' | 'danbooru' | 'custom';

/** The sources an import owns, and so replaces wholesale. */
const IMPORTED_SOURCES = ['e621', 'danbooru'] as const;

export type TagAlias = {
  antecedent: string;
  consequent: string;
  source: TagAliasSource;
};

type AliasRow = { antecedent: string; consequent: string; source: string };

/**
 * Every alias, custom rows last so a caller building a lookup map lets a
 * custom alias overwrite the imported one for the same antecedent. Nothing
 * writes 'custom' rows any more (issue #308); the ones already in the table
 * keep working, and an import still leaves them alone.
 */
export const listAliases = (): TagAlias[] =>
  (
    sqlite
      .prepare(
        `SELECT antecedent, consequent, source FROM tag_aliases
         ORDER BY CASE source WHEN 'custom' THEN 1 ELSE 0 END, antecedent ASC`
      )
      .all() as AliasRow[]
  ).map((row) => ({
    antecedent: row.antecedent,
    consequent: row.consequent,
    source: row.source as TagAliasSource
  }));

export const aliasLookup = (): Map<string, string> =>
  new Map(listAliases().map((alias) => [alias.antecedent, alias.consequent]));

/**
 * Swaps the imported alias rows for a fresh set. Custom rows are untouched,
 * and an imported row whose antecedent the user has claimed is skipped so
 * the import cannot silently take an alias back off them.
 *
 * Rows are inserted in the order given, and the first one to claim an
 * antecedent keeps it — the caller orders the sources it trusts most first.
 */
export const replaceImportedAliases = (
  pairs: { antecedent: string; consequent: string; source: TagAliasSource }[]
) => {
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `DELETE FROM tag_aliases WHERE source IN (${IMPORTED_SOURCES.map(() => '?').join(',')})`
      )
      .run(...IMPORTED_SOURCES);
    const insert = sqlite.prepare(
      `INSERT INTO tag_aliases (antecedent, consequent, source)
       VALUES (?, ?, ?)
       ON CONFLICT(antecedent) DO NOTHING`
    );
    for (const pair of pairs) {
      insert.run(pair.antecedent, pair.consequent, pair.source);
    }
  });
  tx();
};

export const replaceImplications = (
  closure: ReadonlyMap<string, ReadonlySet<string>>
) => {
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM tag_implications').run();
    const insert = sqlite.prepare(
      'INSERT INTO tag_implications (tag, implied) VALUES (?, ?)'
    );
    for (const [tag, implied] of closure) {
      for (const parent of implied) insert.run(tag, parent);
    }
  });
  tx();
};

export const implicationsFor = (tags: string[]): string[] => {
  if (tags.length === 0) return [];
  const placeholders = tags.map(() => '?').join(',');
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT implied FROM tag_implications WHERE tag IN (${placeholders})`
    )
    .all(...tags) as { implied: string }[];
  return rows.map((row) => row.implied);
};

/**
 * Rewrites `canonical_tag` on every stored tag. Runs after an import or an
 * alias edit; the whole table is small enough (one row per tag per file)
 * that a targeted update is not worth the bookkeeping.
 */
export const recanonicaliseFileTags = (resolve: (tag: string) => string) => {
  const rows = sqlite.prepare('SELECT DISTINCT tag FROM file_tags').all() as {
    tag: string;
  }[];
  const tx = sqlite.transaction(() => {
    const update = sqlite.prepare(
      'UPDATE file_tags SET canonical_tag = ? WHERE tag = ? AND canonical_tag <> ?'
    );
    for (const row of rows) {
      const canonical = resolve(row.tag);
      update.run(canonical, row.tag, canonical);
    }
  });
  tx();
};

export const suppressTags = (fileId: string, tags: string[]) => {
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    const insert = sqlite.prepare(
      `INSERT INTO file_tag_suppressions (file_id, tag, created_at)
       VALUES (?, ?, ?) ON CONFLICT(file_id, tag) DO NOTHING`
    );
    for (const tag of tags) insert.run(fileId, tag, now);
  });
  tx();
};

export const clearSuppressions = (fileId: string) =>
  sqlite
    .prepare('DELETE FROM file_tag_suppressions WHERE file_id = ?')
    .run(fileId).changes ?? 0;

export const listSuppressedTags = (fileId: string): string[] =>
  (
    sqlite
      .prepare('SELECT tag FROM file_tag_suppressions WHERE file_id = ?')
      .all(fileId) as { tag: string }[]
  ).map((row) => row.tag);

export type TagSuggestion = { tag: string; files: number };

/** `%` and `_` are LIKE wildcards; typed into the box they must be literal. */
const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Tags from the user's own library, most-used first, for the search box.
 *
 * Suggests canonical names only: they are what the search matches, and
 * offering `1girls` next to `female` would list the same files twice under
 * two names. Suppressed tags are left out — a tag the user removed
 * everywhere should not be suggested back to them.
 */
export const suggestTags = (
  userId: string,
  prefix: string,
  limit: number
): TagSuggestion[] => {
  // Prefix first, then anywhere: typing `fem` should reach `female` before
  // `light-skinned_female`, which a bare LIKE '%fem%' would order by count
  // alone.
  const rows = sqlite
    .prepare(
      `SELECT ft.canonical_tag AS tag, COUNT(DISTINCT ft.file_id) AS files
       FROM file_tags ft
       JOIN files f ON f.id = ft.file_id
       WHERE f.folder_id IN (SELECT id FROM folders WHERE user_id = ?)
         AND ft.canonical_tag LIKE ? ESCAPE '\\'
         AND NOT EXISTS (
           SELECT 1 FROM file_tag_suppressions s
           WHERE s.file_id = ft.file_id AND s.tag = ft.tag
         )
       GROUP BY ft.canonical_tag
       ORDER BY (ft.canonical_tag LIKE ? ESCAPE '\\') DESC, files DESC, tag ASC
       LIMIT ?`
    )
    .all(
      userId,
      `%${escapeLikePattern(prefix)}%`,
      `${escapeLikePattern(prefix)}%`,
      limit
    ) as {
    tag: string;
    files: number;
  }[];
  return rows.map((row) => ({ tag: row.tag, files: Number(row.files) }));
};

/**
 * Like `suggestTags`, but over the whole known vocabulary rather than the
 * user's own files. Explore searches remote boorus, where a tag the library
 * has never seen is exactly what the user is reaching for — the opposite of
 * the gallery, whose suggestions must stay inside what it can actually show.
 *
 * The vocabulary is the imported alias and implication tables: no extra
 * import, and every name in them is a tag some booru really uses. Names the
 * user's own files carry come first and keep their file count; the rest
 * follow with `files: 0`.
 */
export const suggestVocabulary = (
  userId: string,
  prefix: string,
  limit: number
): TagSuggestion[] => {
  const own = suggestTags(userId, prefix, limit);
  if (own.length >= limit) return own;
  const seen = new Set(own.map((entry) => entry.tag));
  const pattern = `%${escapeLikePattern(prefix)}%`;
  const prefixPattern = `${escapeLikePattern(prefix)}%`;
  const rows = sqlite
    .prepare(
      `SELECT tag FROM (
         SELECT consequent AS tag FROM tag_aliases WHERE consequent LIKE ? ESCAPE '\\'
         UNION
         SELECT antecedent FROM tag_aliases WHERE antecedent LIKE ? ESCAPE '\\'
         UNION
         SELECT tag FROM tag_implications WHERE tag LIKE ? ESCAPE '\\'
         UNION
         SELECT implied FROM tag_implications WHERE implied LIKE ? ESCAPE '\\'
       )
       ORDER BY (tag LIKE ? ESCAPE '\\') DESC, LENGTH(tag) ASC, tag ASC
       LIMIT ?`
    )
    .all(pattern, pattern, pattern, pattern, prefixPattern, limit * 2) as {
    tag: string;
  }[];
  for (const row of rows) {
    if (own.length >= limit) break;
    if (seen.has(row.tag)) continue;
    seen.add(row.tag);
    own.push({ tag: row.tag, files: 0 });
  }
  return own;
};

/** Replaces the imported tag -> category map wholesale. */
export const replaceTagCategories = (
  entries: { tag: string; category: string }[]
) => {
  const tx = sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM tag_categories').run();
    const insert = sqlite.prepare(
      `INSERT INTO tag_categories (tag, category) VALUES (?, ?)
       ON CONFLICT(tag) DO NOTHING`
    );
    for (const entry of entries) insert.run(entry.tag, entry.category);
  });
  tx();
};

/** The imported category for a tag, or null when the import never saw it. */
export const categoryForTag = (tag: string): string | null => {
  const row = sqlite
    .prepare('SELECT category FROM tag_categories WHERE tag = ?')
    .get(tag) as { category: string } | undefined;
  return row?.category ?? null;
};

/**
 * Moves stored tags off 'general' wherever the imported map knows better.
 *
 * 'general' is what every write path uses when the booru said nothing, so
 * it doubles as "unknown" and is safe to overwrite. A category the user
 * picked by hand is not: MANUAL rows are left exactly as they are.
 */
export const recategoriseFileTags = (): number =>
  sqlite
    .prepare(
      `UPDATE file_tags
          SET category = (SELECT c.category FROM tag_categories c WHERE c.tag = file_tags.tag)
        WHERE source <> 'MANUAL'
          AND category = 'general'
          AND EXISTS (SELECT 1 FROM tag_categories c WHERE c.tag = file_tags.tag)`
    )
    .run().changes ?? 0;

export const getMeta = (key: string): string | null => {
  const row = sqlite
    .prepare('SELECT value FROM tag_db_meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setMeta = (key: string, value: string) => {
  sqlite
    .prepare(
      `INSERT INTO tag_db_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
};

export const countRows = (
  table: 'tag_aliases' | 'tag_implications' | 'tag_categories'
): number => {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
    .get() as {
    total: number;
  };
  return row.total;
};

export const tagDbRepo = {
  suggestTags,
  suggestVocabulary,
  listAliases,
  aliasLookup,
  replaceImportedAliases,
  replaceImplications,
  implicationsFor,
  recanonicaliseFileTags,
  replaceTagCategories,
  categoryForTag,
  recategoriseFileTags,
  suppressTags,
  clearSuppressions,
  listSuppressedTags,
  getMeta,
  setMeta,
  countRows
};
