// setupProductionEnv MUST be imported BEFORE any `src/` module, so
// NODE_ENV=production + AUTH_COOKIE_SECURE=false land before `config.ts`
// reads them. Each test file is its own subprocess under `node --test`.
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
 * #67 regression guard — production-env, explicit AUTH_COOKIE_SECURE=false.
 *
 * Sibling matrix row of `auth.cookie-secure-true.test.ts`. Together they
 * pin the prod-env cookie shape in both directions. The development-env
 * default is pinned by `auth.routes.test.ts`.
 *
 * Why this lives in its own file: setting NODE_ENV/AUTH_COOKIE_SECURE in
 * a `before` hook would race the `import './...config'` chain that
 * `buildTestApp` triggers. Putting the env mutation in a module-load
 * setup file guarantees it lands first.
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
  assert.equal(parsed.sameSite, 'strict');
  assert.equal(
    parsed.flags.has('secure'),
    false,
    'Secure must be off when AUTH_COOKIE_SECURE=false in production'
  );
});
