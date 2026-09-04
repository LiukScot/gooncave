/**
 * One-off backfill for tags stored before the engine could read their
 * category (issue #311).
 *
 * Gelbooru-style boorus report no category in the API the tagger used, so
 * everything they returned was filed under 'general' and stayed that way —
 * a file already in the library never re-reads its tags on its own. The
 * category is not derivable offline: it only exists on the booru, so this
 * asks for it, one post at a time.
 *
 * Selection is engine-agnostic on purpose. Anything whose tags from one
 * booru source are *entirely* 'general' is a candidate, which is exactly the
 * set that was mis-filed and excludes everything e621 and danbooru wrote.
 * A post that genuinely carries only general tags is re-fetched once and
 * rewritten identically — one wasted request, no wrong data.
 *
 *   bun src/backfill-tag-categories.ts --dry-run
 *   bun src/backfill-tag-categories.ts
 *
 * Safe to interrupt and re-run: a file it has already fixed no longer
 * matches the query.
 */
import { sqlite } from './db/client';
import { authRepo } from './db/repos/authRepo';
import { booruSitesRepo } from './db/repos/booruSitesRepo';
import { filesRepo } from './db/repos/filesRepo';
import type { BooruSiteRecord } from './db/types';
import { SPECIAL_TAG_SOURCES } from './db/types';
import { getEngine } from './lib/booruEngines';
import { redactUrlSecrets } from './lib/booruEngines/helpers';
import { applyRemotePostTags } from './services/tagging';

/** Boorus rate-limit; this is a repair job, not a race. */
const REQUEST_INTERVAL_MS = 1_000;

type Candidate = {
  fileId: string;
  source: string;
  sourceUrl: string;
};

const findCandidates = (): Candidate[] => {
  const placeholders = SPECIAL_TAG_SOURCES.map(() => '?').join(', ');
  return sqlite
    .prepare(
      `SELECT file_id AS fileId,
              source,
              MAX(source_url) AS sourceUrl
         FROM file_tags
        WHERE source NOT IN (${placeholders})
          AND source_url IS NOT NULL
        GROUP BY file_id, source
       HAVING SUM(CASE WHEN category <> 'general' THEN 1 ELSE 0 END) = 0
        ORDER BY file_id`
    )
    .all(...SPECIAL_TAG_SOURCES) as Candidate[];
};

/**
 * The site a stored tag source points at. `file_tags.source` is either a
 * legacy preset key or a booru site id, the same two things
 * `applyRemotePostTags` accepts.
 */
const resolveSite = async (
  source: string,
  userId: string
): Promise<BooruSiteRecord | null> => {
  const byId = await booruSitesRepo.getBooruSite(source, userId);
  if (byId) return byId;
  return booruSitesRepo.findBooruSiteByPresetKey(source, userId);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const candidates = findCandidates();
  if (!candidates.length) {
    process.stdout.write('[backfill] nothing to do\n');
    return;
  }

  const files = new Set(candidates.map((entry) => entry.fileId));
  process.stdout.write(
    `[backfill] ${candidates.length} tag sets across ${files.size} files\n`
  );
  if (dryRun) {
    process.stdout.write('[backfill] dry run, nothing written\n');
    return;
  }

  let fixed = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, candidate] of candidates.entries()) {
    if (index > 0) await sleep(REQUEST_INTERVAL_MS);
    const progress = `${index + 1}/${candidates.length}`;
    try {
      const file = await filesRepo.findFileById(candidate.fileId);
      const user = await authRepo.findUserByFileId(candidate.fileId);
      if (!file || !user) {
        skipped += 1;
        continue;
      }
      const site = await resolveSite(candidate.source, user.id);
      const engine = site ? getEngine(site.engine) : null;
      if (!site || !engine) {
        // The site was deleted after the tags were written; there is nothing
        // left to ask, and the tags stay as they are.
        skipped += 1;
        continue;
      }
      const extracted = engine.extractIdFromUrl(candidate.sourceUrl, site);
      if (!extracted) {
        skipped += 1;
        continue;
      }
      const result = await applyRemotePostTags(
        file,
        candidate.source,
        extracted.remoteId,
        candidate.sourceUrl
      );
      if (result.applied) {
        fixed += 1;
        process.stdout.write(
          `[backfill] ${progress} ${site.name}#${extracted.remoteId}: ${result.count} tags\n`
        );
      } else {
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      // Gelbooru-style URLs carry user_id/api_key and undici embeds them in
      // network errors, so redact before this reaches a terminal or a log.
      process.stderr.write(
        `[backfill] ${progress} ${candidate.fileId} failed: ${redactUrlSecrets(
          (err as Error).message
        )}\n`
      );
    }
  }

  process.stdout.write(
    `[backfill] done: ${fixed} rewritten, ${skipped} skipped, ${failed} failed\n`
  );
};

void main().catch((err) => {
  process.stderr.write(
    `[backfill] failed: ${redactUrlSecrets((err as Error).message)}\n`
  );
  process.exit(1);
});
