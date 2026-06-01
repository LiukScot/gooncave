// setupProductionEnvSecureTrue MUST be the first import: it sets
// NODE_ENV=production + AUTH_COOKIE_SECURE=true before `config.ts`
// loads. Top-level `process.env = ...` writes won't work here because
// TypeScript hoists imports above statements when compiling to
// CommonJS — the env mutation has to live inside a setup module.
import './helpers/setupProductionEnvSecureTrue';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { getRawSetCookie, parseSetCookieFlags } from './helpers/cookies';
import { buildTestApp } from './helpers/testApp';

let app: FastifyInstance;

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  await app.close();
});

/**
 * Negative-case fence for the #67 fix. The fix made `cookieSecure`
 * env-driven; this test pins the inverse direction so we can't
 * accidentally regress to "Secure is always off" (which would be just
 * as broken under HTTPS deployments).
 */
test('production env with AUTH_COOKIE_SECURE=true: Set-Cookie includes Secure', async () => {
  // bun runs every test file in one process, so the sibling secure=false file
  // shares this process.env. Pin the flag here so the live config getter reads
  // the right value regardless of file load order.
  process.env.AUTH_COOKIE_SECURE = 'true';
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'secure_user', password: 'longenoughpassword' }
  });
  assert.equal(res.statusCode, 200);
  const parsed = parseSetCookieFlags(
    getRawSetCookie(res.headers['set-cookie'])
  );
  assert.equal(parsed.name, 'gooncave_session');
  assert.ok(parsed.flags.has('httponly'));
  assert.ok(
    parsed.flags.has('secure'),
    'Secure must be on when AUTH_COOKIE_SECURE=true'
  );
});
