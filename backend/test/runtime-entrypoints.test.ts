import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Database } from 'bun:sqlite';

const backendRoot = path.resolve(__dirname, '..');

const runBuild = () =>
  spawnSync('bun', ['run', 'build'], {
    cwd: backendRoot,
    env: process.env,
    encoding: 'utf8'
  });

const runBuiltMigrate = (dataFile: string) =>
  spawnSync('bun', ['dist/migrate.js'], {
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
  spawnSync('bun', ['dist/startWorker.js'], {
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

const runBuiltApiBoot = (dataFile: string) =>
  spawnSync('bun', ['dist/index.js'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      DATA_FILE: dataFile,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      FRONTEND_DIR: '',
      TAGGER_URL: '',
      FAVORITES_SYNC_INTERVAL_HOURS: '0',
      LOCAL_RESCAN_INTERVAL_MINUTES: '0',
      WD14_BACKFILL_INTERVAL_HOURS: '0',
      API_EXIT_AFTER_BOOT: 'true'
    },
    encoding: 'utf8'
  });

// Each test runs a full `bun run build` (tsc); the default 5s timeout is too
// tight for a cold CI runner, so give the build room.
const BUILD_TEST_TIMEOUT = 120_000;

test(
  'build copies SQL migrations into dist for runtime migrate command',
  { timeout: BUILD_TEST_TIMEOUT },
  () => {
    const buildResult = runBuild();
    assert.equal(
      buildResult.status,
      0,
      buildResult.stderr || buildResult.stdout
    );

    const sqlPath = path.join(
      backendRoot,
      'dist',
      'db',
      'migrations',
      '0000_initial.sql'
    );
    assert.ok(
      fs.existsSync(sqlPath),
      'build should copy SQL migrations into dist/db/migrations'
    );

    const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
    assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

    const dataFile = path.join(tmpRoot, 'runtime-built-migrate.sqlite');
    const migrateResult = runBuiltMigrate(dataFile);
    assert.equal(
      migrateResult.status,
      0,
      migrateResult.stderr || migrateResult.stdout
    );
  }
);

test(
  'built worker boot migrates schema before startup queries run',
  { timeout: BUILD_TEST_TIMEOUT },
  () => {
    const buildResult = runBuild();
    assert.equal(
      buildResult.status,
      0,
      buildResult.stderr || buildResult.stdout
    );

    const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
    assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

    const dataFile = path.join(tmpRoot, 'runtime-worker-boot.sqlite');
    const workerResult = runBuiltWorkerBoot(dataFile);
    assert.equal(
      workerResult.status,
      0,
      workerResult.stderr || workerResult.stdout
    );

    const db = new Database(dataFile, { readonly: true });
    const scansTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scans'"
      )
      .get() as { name: string } | undefined;
    const usersTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
      )
      .get() as { name: string } | undefined;
    db.close();

    assert.equal(scansTable?.name, 'scans');
    assert.equal(usersTable?.name, 'users');
  }
);

test(
  'built api boot migrates schema before startup queries run',
  { timeout: BUILD_TEST_TIMEOUT },
  () => {
    const buildResult = runBuild();
    assert.equal(
      buildResult.status,
      0,
      buildResult.stderr || buildResult.stdout
    );

    const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT;
    assert.ok(tmpRoot, 'GOONCAVE_TEST_TMP_ROOT must be set by setupEnv');

    const dataFile = path.join(tmpRoot, 'runtime-api-boot.sqlite');
    const apiResult = runBuiltApiBoot(dataFile);
    assert.equal(apiResult.status, 0, apiResult.stderr || apiResult.stdout);

    const db = new Database(dataFile, { readonly: true });
    const siteFlags = db
      .prepare(
        `SELECT name
       FROM pragma_table_info('user_booru_sites')
       WHERE name IN (
         'site_auto_sync_midnight',
         'site_reverse_sync_enabled',
         'site_auto_fav_enabled'
       )
       ORDER BY name ASC`
      )
      .all() as Array<{ name: string }>;
    db.close();

    assert.deepEqual(
      siteFlags.map((row) => row.name),
      [
        'site_auto_fav_enabled',
        'site_auto_sync_midnight',
        'site_reverse_sync_enabled'
      ]
    );
  }
);
