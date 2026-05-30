/**
 * Production-environment bootstrap with `AUTH_COOKIE_SECURE=false`.
 *
 * Used by the #67 regression guard that pins:
 *   prod env + explicit AUTH_COOKIE_SECURE=false ⇒ no `Secure` on the cookie.
 *
 * Lives next to `setupProductionEnvSecureTrue.ts` so the prod-cookie matrix
 * (false / true) reads as two sibling rows. Each test file runs in its own
 * subprocess under Node's `--test` runner, so the env writes don't leak.
 *
 * Why a separate setup file and not `process.env = …` at the top of the
 * test: TypeScript hoists `import` statements above top-level expressions
 * when compiling to CommonJS, so a process.env write before an import
 * would still run *after* the import resolves. Module-level side effects
 * inside an imported setup module dodge that hoist.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), `gooncave-test-prod-${randomUUID()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

const setIfUnset = (key: string, value: string) => {
  if (process.env[key] === undefined) process.env[key] = value;
};

process.env.NODE_ENV = 'production';
setIfUnset('AUTH_COOKIE_SECURE', 'false');
setIfUnset('DATA_FILE', ':memory:');
setIfUnset('THUMBNAILS_DIR', path.join(tmpRoot, 'thumbnails'));
setIfUnset('MEDIA_PATH', path.join(tmpRoot, 'media'));
setIfUnset('FRONTEND_DIR', '');
setIfUnset('ALLOWED_ORIGINS', 'http://allowed.test');
setIfUnset('AUTH_SESSION_TTL_HOURS', '1');
setIfUnset('FAVORITES_SYNC_INTERVAL_HOURS', '0');

process.env.GOONCAVE_TEST_TMP_ROOT = tmpRoot;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runMigrations } = require('../../src/db/migrate');
runMigrations();

process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[test cleanup] failed to remove ${tmpRoot}: ${(err as Error).message}\n`);
  }
});
