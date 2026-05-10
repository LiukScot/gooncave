// setupProductionEnv MUST be imported before any `src/` module so that
// NODE_ENV=production + AUTH_COOKIE_SECURE=false land before `config.ts`
// reads them.
import './helpers/setupProductionEnv';

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
 * Issue #67 regression guard, production-env edition.
 *
 * The bug: the prod default flipped `Secure` on, but the deployed stack
 * served plain HTTP, so chromium dropped the cookie and the user was
 * kicked back to the login screen. The fix flipped the default of
 * `AUTH_COOKIE_SECURE` to read from env (default false). This test
 * pins the production-env happy path: explicit `false` keeps the cookie
 * usable on http.
 */
test('production env with AUTH_COOKIE_SECURE=false: Set-Cookie has no Secure flag', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'prod_user', password: 'longenoughpassword' }
  });
  assert.equal(res.statusCode, 200);
  const parsed = parseSetCookieFlags(getRawSetCookie(res.headers['set-cookie']));
  assert.equal(parsed.name, 'gooncave_session');
  assert.ok(parsed.flags.has('httponly'), 'cookie missing HttpOnly');
  assert.equal(parsed.sameSite, 'lax');
  assert.equal(
    parsed.flags.has('secure'),
    false,
    'Secure must be off when AUTH_COOKIE_SECURE=false in production'
  );
});
