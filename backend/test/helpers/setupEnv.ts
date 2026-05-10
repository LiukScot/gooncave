/**
 * Test environment bootstrap.
 *
 * Runs BEFORE any app module loads (wired via `tsx --test --import`).
 * Each test file runs in its own subprocess (Node's test runner default),
 * so each gets an isolated tmp dir and a fresh in-memory SQLite database.
 *
 * Why this exists: `lib/dataStore` opens the SQLite file at module load
 * time, reading `config.storage.dataFile` from env. Setting env at this
 * stage is the only way to redirect the DB without spawning a separate
 * process per test.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), `gooncave-test-${randomUUID()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

const setIfUnset = (key: string, value: string) => {
  if (process.env[key] === undefined) process.env[key] = value;
};

setIfUnset('NODE_ENV', 'test');
// `:memory:` is per-process; safe because each test file = own subprocess.
setIfUnset('DATA_FILE', ':memory:');
setIfUnset('THUMBNAILS_DIR', path.join(tmpRoot, 'thumbnails'));
setIfUnset('MEDIA_PATH', path.join(tmpRoot, 'media'));
// Empty FRONTEND_DIR disables the static-file plugin in createServer().
setIfUnset('FRONTEND_DIR', '');
setIfUnset('ALLOWED_ORIGINS', 'http://allowed.test');
setIfUnset('AUTH_SESSION_TTL_HOURS', '1');
setIfUnset('FAVORITES_SYNC_INTERVAL_HOURS', '0');

// Expose tmp root for tests that need a real on-disk path.
process.env.GOONCAVE_TEST_TMP_ROOT = tmpRoot;

process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    // Don't throw from an exit handler — but per AGENTS.md §4 we still
    // surface failures so leftover tmp dirs are diagnosable.
    process.stderr.write(`[test cleanup] failed to remove ${tmpRoot}: ${(err as Error).message}\n`);
  }
});
