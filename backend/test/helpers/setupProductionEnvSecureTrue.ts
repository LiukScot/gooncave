/**
 * Production-environment bootstrap with `Secure` cookie ENABLED.
 *
 * Sibling of `setupProductionEnv.ts`. Used by the negative-case test
 * that pins the inverse of the #67 fix: when an HTTPS deployment opts
 * in via `AUTH_COOKIE_SECURE=true`, the cookie must include `Secure`.
 *
 * Lives in a separate file (instead of the test file setting env then
 * importing) because TypeScript hoists `import` statements above
 * top-level expressions when compiling to CommonJS — so a `process.env`
 * write before an `import` would still run *after* the import resolves.
 * Module-level side effects in a setup file dodge that hoisting.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = path.join(os.tmpdir(), `gooncave-test-prod-secure-${randomUUID()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

const setIfUnset = (key: string, value: string) => {
  if (process.env[key] === undefined) process.env[key] = value;
};

process.env.NODE_ENV = 'production';
process.env.AUTH_COOKIE_SECURE = 'true';
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
