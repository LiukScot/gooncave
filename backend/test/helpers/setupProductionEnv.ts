/**
 * Production-environment bootstrap for cookie regression tests.
 *
 * Twin of `setupEnv.ts`. The difference: this one sets `NODE_ENV=production`
 * before any `src/` import so `config.auth.cookieSecure` reads its
 * production default and `setSessionCookie` emits the production-shape
 * cookie on `Set-Cookie`.
 *
 * Each test file that imports this gets its own subprocess (Node's
 * `--test` runner forks per file), so the env-var write is fully
 * isolated from the rest of the suite.
 *
 * Why this exists: the existing `auth.routes.test.ts` runs under
 * `NODE_ENV=test`, which means `cookieSecure` defaults to `false`. That
 * leaves the production cookie path untested — exactly the path that
 * shipped the #67 bug. This setup closes the gap.
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

// Force production. Test files that need a different cookieSecure can
// override AUTH_COOKIE_SECURE before importing — env is read once, at
// `config.ts` load time.
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

process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[test cleanup] failed to remove ${tmpRoot}: ${(err as Error).message}\n`);
  }
});
