import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import BetterSqlite3 from 'better-sqlite3';

const backendRoot = path.resolve(__dirname, '..');

const runBuild = () =>
  spawnSync('npm', ['run', 'build'], {
    cwd: backendRoot,
    env: process.env,
    encoding: 'utf8'
  });

const runBuiltMigrate = (dataFile: string) =>
  spawnSync('node', ['dist/migrate.js'], {
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

const runBuiltWorkerBoot = (dataFile: string) =>
  spawnSync('node', ['dist/startWorker.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATA_FILE: dataFile,
      NODE_ENV: 'test',
      FRONTEND_DIR: '',
      TAGGER_URL: '',
      FAVORITES_SYNC_INTERVAL_HOURS: '0',
      LOCAL_RESCAN_INTERVAL_MINUTES: '0',
      WD14_BACKFILL_INTERVAL_HOURS: '0',
      WORKER_EXIT_AFTER_BOOT: 'true'
    },
    encoding: 'utf8'
  });

test('build copies SQL migrations into dist for runtime migrate command', () => {
  const buildResult = runBuild();
  assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);

  const sqlPath = path.join(backendRoot, 'dist', 'db', 'migrations', '0000_initial.sql');
  assert.ok(fs.existsSync(sqlPath), 'build should copy SQL migrations into dist/db/migrations');

  const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
  assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

  const dataFile = path.join(tmpRoot, 'runtime-built-migrate.sqlite');
  const migrateResult = runBuiltMigrate(dataFile);
  assert.equal(migrateResult.status, 0, migrateResult.stderr || migrateResult.stdout);
});

test('built worker boot migrates schema before startup queries run', () => {
  const buildResult = runBuild();
  assert.equal(buildResult.status, 0, buildResult.stderr || buildResult.stdout);

  const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
  assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

  const dataFile = path.join(tmpRoot, 'runtime-worker-boot.sqlite');
  const workerResult = runBuiltWorkerBoot(dataFile);
  assert.equal(workerResult.status, 0, workerResult.stderr || workerResult.stdout);

  const db = new BetterSqlite3(dataFile, { readonly: true });
  const scansTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scans'")
    .get() as { name: string } | undefined;
  const usersTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { name: string } | undefined;
  db.close();

  assert.equal(scansTable?.name, 'scans');
  assert.equal(usersTable?.name, 'users');
});
