import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { sqlite } from './client';

const migrationsDir = path.join(__dirname, 'migrations');

const ensureMigrationsTable = () => {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  const columns = sqlite.prepare('PRAGMA table_info(__drizzle_migrations)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'name')) {
    sqlite.exec('ALTER TABLE __drizzle_migrations ADD COLUMN name TEXT;');
  }
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_drizzle_migrations_name ON __drizzle_migrations(name);');
};

const migrationFiles = () =>
  fs
    .readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

const migrationHash = (sql: string) => createHash('sha256').update(sql).digest('hex');

const findAppliedMigration = (fileName: string) =>
  sqlite
    .prepare(
      `SELECT id, hash, name
       FROM __drizzle_migrations
       WHERE name = ? OR (name IS NULL AND hash = ?)
       LIMIT 1`
    )
    .get(fileName, fileName) as { id: number; hash: string; name?: string | null } | undefined;

export const runMigrations = () => {
  ensureMigrationsTable();

  for (const fileName of migrationFiles()) {
    const sql = fs.readFileSync(path.join(migrationsDir, fileName), 'utf8');
    const checksum = migrationHash(sql);
    const applyMigration = sqlite.transaction(() => {
      const existing = findAppliedMigration(fileName);
      if (existing) {
        if (existing.hash === checksum && existing.name === fileName) return;
        if (existing.hash === fileName || existing.name === null || existing.name === undefined) {
          sqlite
            .prepare('UPDATE __drizzle_migrations SET hash = ?, name = ? WHERE id = ?')
            .run(checksum, fileName, existing.id);
          return;
        }
        throw new Error(`Migration checksum mismatch for ${fileName}`);
      }
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO __drizzle_migrations (hash, name, created_at) VALUES (?, ?, ?)')
        .run(checksum, fileName, Date.now());
    });
    applyMigration();
  }
};
