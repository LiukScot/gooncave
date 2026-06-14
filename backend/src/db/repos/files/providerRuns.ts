import { randomUUID } from 'crypto';

import type { ProviderRunRecord } from '../../../db/types';

import {
  mapProviderRunRow,
  sqlite,
  withSqliteRetry,
  type ProviderRunRow
} from './shared';

export const listProviderRuns = async (fileId: string) => {
  const rows = sqlite
    .prepare(
      'SELECT * FROM provider_runs WHERE file_id = ? ORDER BY COALESCE(completed_at, created_at) DESC'
    )
    .all(fileId) as ProviderRunRow[];
  return rows.map(mapProviderRunRow);
};

export const listProviderRunsByFileIds = async (fileIds: string[]) => {
  const grouped: Record<string, ProviderRunRecord[]> = {};
  if (fileIds.length === 0) return grouped;
  const placeholders = fileIds.map(() => '?').join(',');
  const rows = sqlite
    .prepare(
      `SELECT * FROM provider_runs
       WHERE file_id IN (${placeholders})
       ORDER BY file_id ASC, COALESCE(completed_at, created_at) DESC`
    )
    .all(...fileIds) as ProviderRunRow[];
  for (const row of rows) {
    const run = mapProviderRunRow(row);
    if (!grouped[run.fileId]) grouped[run.fileId] = [];
    grouped[run.fileId].push(run);
  }
  return grouped;
};

export const createProviderRunWithLimit = async (
  fileId: string,
  provider: 'SAUCENAO' | 'FLUFFLE',
  limit: number,
  windowMs: number
) => {
  const now = new Date();
  const createdAt = now.toISOString();
  const windowStart = new Date(now.getTime() - windowMs).toISOString();
  const insertProviderRun = sqlite.prepare(
    `INSERT INTO provider_runs (id, file_id, provider, status, cached_hit, score, source_url, thumb_url, results, created_at, completed_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = sqlite.transaction(() => {
    // Quota is counted globally per provider, not per user, on purpose: the
    // SauceNAO/Fluffle limit is tied to the API key (one key per provider for
    // this single-user app), so a per-user window would let the real upstream
    // limit be exceeded. Keep this global. (issue #200 finding 3)
    const countRow = sqlite
      .prepare(
        'SELECT COUNT(1) AS count FROM provider_runs WHERE provider = ? AND created_at >= ? AND cached_hit = 0'
      )
      .get(provider, windowStart) as { count?: number } | undefined;
    const count = Number(countRow?.count ?? 0);
    if (count >= limit) {
      const oldestRow = sqlite
        .prepare(
          'SELECT created_at FROM provider_runs WHERE provider = ? AND created_at >= ? AND cached_hit = 0 ORDER BY created_at ASC LIMIT 1'
        )
        .get(provider, windowStart) as { created_at?: string } | undefined;
      const oldest = oldestRow?.created_at
        ? new Date(oldestRow.created_at)
        : null;
      const retryAt = oldest
        ? new Date(oldest.getTime() + windowMs).toISOString()
        : null;
      return { run: null, rateLimited: true, retryAt, count };
    }

    const run: ProviderRunRecord = {
      id: randomUUID(),
      fileId,
      provider,
      status: 'PENDING',
      cachedHit: false,
      score: null,
      sourceUrl: null,
      thumbUrl: null,
      results: [],
      createdAt,
      completedAt: null,
      error: null
    };
    insertProviderRun.run(
      run.id,
      run.fileId,
      run.provider,
      run.status,
      run.cachedHit ? 1 : 0,
      run.score,
      run.sourceUrl,
      run.thumbUrl,
      JSON.stringify(run.results ?? []),
      run.createdAt,
      run.completedAt,
      run.error
    );
    return { run, rateLimited: false, retryAt: null, count: count + 1 };
  });
  return withSqliteRetry(() => tx());
};

export const createProviderRun = async (
  fileId: string,
  provider: 'SAUCENAO' | 'FLUFFLE'
) => {
  const now = new Date().toISOString();
  const run: ProviderRunRecord = {
    id: randomUUID(),
    fileId,
    provider,
    status: 'PENDING',
    cachedHit: false,
    score: null,
    sourceUrl: null,
    thumbUrl: null,
    results: [],
    createdAt: now,
    completedAt: null,
    error: null
  };
  await withSqliteRetry(() => {
    sqlite
      .prepare(
        `INSERT INTO provider_runs (id, file_id, provider, status, cached_hit, score, source_url, thumb_url, results, created_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.fileId,
        run.provider,
        run.status,
        run.cachedHit ? 1 : 0,
        run.score,
        run.sourceUrl,
        run.thumbUrl,
        JSON.stringify(run.results ?? []),
        run.createdAt,
        run.completedAt,
        run.error
      );
  });
  return run;
};

export const updateProviderRun = async (
  id: string,
  updates: Partial<Omit<ProviderRunRecord, 'id' | 'fileId'>>
) =>
  withSqliteRetry(() => {
    const existingRow = sqlite
      .prepare('SELECT * FROM provider_runs WHERE id = ?')
      .get(id) as ProviderRunRow | undefined;
    if (!existingRow) return null;
    const existing = mapProviderRunRow(existingRow);
    const run: ProviderRunRecord = {
      ...existing,
      ...updates
    };
    sqlite
      .prepare(
        `UPDATE provider_runs SET provider = ?, status = ?, cached_hit = ?, score = ?, source_url = ?, thumb_url = ?, results = ?, created_at = ?, completed_at = ?, error = ? WHERE id = ?`
      )
      .run(
        run.provider,
        run.status,
        run.cachedHit ? 1 : 0,
        run.score,
        run.sourceUrl,
        run.thumbUrl,
        JSON.stringify(run.results ?? []),
        run.createdAt,
        run.completedAt,
        run.error,
        run.id
      );
    return run;
  });

export const removeProviderRunResultForFile = async (
  fileId: string,
  sourceUrl: string
) => {
  const rows = sqlite
    .prepare('SELECT * FROM provider_runs WHERE file_id = ?')
    .all(fileId) as ProviderRunRow[];
  let removed = 0;
  for (const row of rows) {
    const run = mapProviderRunRow(row);
    const results = Array.isArray(run.results) ? run.results : [];
    if (!results.some((result) => result.sourceUrl === sourceUrl)) continue;
    const filtered = results.filter((result) => result.sourceUrl !== sourceUrl);
    const sorted = [...filtered].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0)
    );
    const top = sorted[0];
    await updateProviderRun(run.id, {
      results: filtered,
      sourceUrl: top?.sourceUrl ?? null,
      score: top?.score ?? null,
      thumbUrl: top?.thumbUrl ?? null
    });
    removed += results.length - filtered.length;
  }
  return removed;
};
