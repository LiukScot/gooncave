import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Database } from 'bun:sqlite';
import { test } from 'bun:test';

const backendRoot = path.resolve(__dirname, '..');

const runMigrate = (dataFile: string) =>
  spawnSync('bun', ['src/migrate.ts'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATA_FILE: dataFile,
      NODE_ENV: 'test',
      FRONTEND_DIR: '',
      FAVORITES_SYNC_INTERVAL_HOURS: '0',
      LOCAL_RESCAN_INTERVAL_MINUTES: '0'
    },
    encoding: 'utf8'
  });

const listTables = (db: Database) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
    .all() as Array<{ name: string }>;

test('migrate command bootstraps empty database with gooncave schema', () => {
  const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
  assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

  const dataFile = path.join(tmpRoot, 'migrate-empty.sqlite');
  const result = runMigrate(dataFile);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(
    fs.existsSync(dataFile),
    'migrate command should create sqlite file'
  );

  const db = new Database(dataFile, { readonly: true });
  const tables = new Set(listTables(db).map((row) => row.name));
  db.close();

  assert.ok(tables.has('__drizzle_migrations'));
  assert.ok(tables.has('users'));
  assert.ok(tables.has('folders'));
  assert.ok(tables.has('files'));
  assert.ok(tables.has('provider_runs'));
  assert.ok(tables.has('user_booru_sites'));
});

test('migrate command upgrades legacy database without dropping existing rows', () => {
  const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
  assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

  const dataFile = path.join(tmpRoot, 'migrate-legacy.sqlite');
  const legacyDb = new Database(dataFile);
  legacyDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      library_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
  `);
  legacyDb
    .prepare(
      `
      INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      'user-1',
      'legacy-user',
      'hash',
      '/tmp/library',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      null
    );
  legacyDb.close();

  const result = runMigrate(dataFile);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const db = new Database(dataFile, { readonly: true });
  const user = db
    .prepare('SELECT id, username, library_root FROM users WHERE id = ?')
    .get('user-1') as
    | { id: string; username: string; library_root: string }
    | undefined;
  const tables = new Set(listTables(db).map((row) => row.name));
  db.close();

  assert.deepEqual(user, {
    id: 'user-1',
    username: 'legacy-user',
    library_root: '/tmp/library'
  });
  assert.ok(tables.has('__drizzle_migrations'));
  assert.ok(tables.has('sessions'));
  assert.ok(tables.has('favorite_items'));
});

test('migrate command upgrades legacy drizzle metadata to checksum + name without rerunning SQL', () => {
  const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
  assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

  const dataFile = path.join(tmpRoot, 'migrate-legacy-metadata.sqlite');
  const db = new Database(dataFile);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      library_root TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE TABLE user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE user_booru_sites (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      engine TEXT NOT NULL,
      base_url TEXT NOT NULL,
      username TEXT,
      api_key TEXT,
      is_preset INTEGER NOT NULL,
      preset_key TEXT,
      enabled INTEGER NOT NULL,
      cap_favorites INTEGER NOT NULL,
      cap_tags INTEGER NOT NULL,
      cap_source_match INTEGER NOT NULL,
      cap_search INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      location_type TEXT NOT NULL,
      path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      phash TEXT,
      media_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      thumb_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'user-legacy',
    'legacy',
    'hash',
    '/tmp/library',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
    null
  );
  db.prepare(
    `INSERT INTO user_booru_sites
      (id, user_id, name, engine, base_url, username, api_key, is_preset, preset_key,
       enabled, cap_favorites, cap_tags, cap_source_match, cap_search, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'site-legacy',
    'user-legacy',
    'Legacy Site',
    'e621',
    'https://e621.net',
    'legacy-user',
    'legacy-key',
    1,
    'E621',
    1,
    1,
    1,
    1,
    1,
    0,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
  db.prepare(
    'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
  ).run('user-legacy', 'favorites_auto_sync_midnight', 'false');
  db.prepare(
    'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
  ).run('user-legacy', 'favorites_reverse_sync', 'true');
  db.prepare(
    'INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)'
  ).run('user-legacy', 'favorites_auto_fav', 'true');
  db.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)'
  ).run('0000_initial.sql', Date.now());
  db.close();

  const result = runMigrate(dataFile);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const migratedDb = new Database(dataFile, { readonly: true });
  const row = migratedDb
    .prepare(
      'SELECT hash, name FROM __drizzle_migrations ORDER BY id ASC LIMIT 1'
    )
    .get() as { hash: string; name: string } | undefined;
  const siteFlags = migratedDb
    .prepare(
      `SELECT site_auto_sync_midnight, site_reverse_sync_enabled, site_auto_fav_enabled
       FROM user_booru_sites
       WHERE id = ?`
    )
    .get('site-legacy') as
    | {
        site_auto_sync_midnight: number;
        site_reverse_sync_enabled: number;
        site_auto_fav_enabled: number;
      }
    | undefined;
  const count = migratedDb
    .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
    .get() as { count: number };
  migratedDb.close();

  assert.ok(row);
  assert.equal(row?.name, '0000_initial.sql');
  assert.notEqual(row?.hash, '0000_initial.sql');
  assert.deepEqual(siteFlags, {
    site_auto_sync_midnight: 0,
    site_reverse_sync_enabled: 1,
    site_auto_fav_enabled: 1
  });
  assert.equal(count.count, 5);
});
