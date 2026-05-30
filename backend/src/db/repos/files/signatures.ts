import { sqlite } from './shared';

export const getSignaturesBatch = (
  fileIds: string[],
  sampleSize: number
): Map<string, { kind: string; data: Buffer; sourceHash: string }> => {
  if (fileIds.length === 0) return new Map();
  const placeholders = fileIds.map(() => '?').join(',');
  const rows = sqlite
    .prepare(
      `SELECT file_id, kind, data, source_hash FROM file_signatures WHERE sample_size = ? AND file_id IN (${placeholders})`
    )
    .all(sampleSize, ...fileIds) as { file_id: string; kind: string; data: Buffer; source_hash: string }[];
  const result = new Map<string, { kind: string; data: Buffer; sourceHash: string }>();
  for (const row of rows) {
    result.set(row.file_id, { kind: row.kind, data: row.data, sourceHash: row.source_hash });
  }
  return result;
};

export const setSignature = (fileId: string, kind: string, sampleSize: number, data: Buffer, sourceHash: string) => {
  sqlite.prepare(
    `INSERT INTO file_signatures (file_id, kind, sample_size, data, source_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET kind = excluded.kind, sample_size = excluded.sample_size, data = excluded.data, source_hash = excluded.source_hash, created_at = datetime('now')`
  ).run(fileId, kind, sampleSize, data, sourceHash);
};
