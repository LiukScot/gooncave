import assert from 'node:assert/strict';

import { afterAll, beforeAll, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { config } from '../src/config';
import { authRepo } from '../src/db/repos/authRepo';

import { getRawSetCookie, parseSetCookieFlags } from './helpers/cookies';
import { buildTestApp, seedUser, sessionCookieFor } from './helpers/testApp';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

const meWith = async (token: string) =>
  app.inject({
    method: 'GET',
    url: '/auth/me',
    cookies: { [config.auth.cookieName]: token }
  });

/**
 * #291: sessions used to carry a hard 24h deadline, so an account in daily
 * use was logged out daily. They are now pushed back to a full term once
 * they are past halfway.
 */
test('a session past halfway is renewed, in the database and on the cookie', async () => {
  const { user } = await seedUser();
  const cookie = await sessionCookieFor(user.id);
  // A quarter of a term left: past the halfway mark, still valid.
  const aged = new Date(Date.now() + config.auth.sessionTtlMs / 4);
  await authRepo.extendSession(cookie.value, aged.toISOString());

  const res = await meWith(cookie.value);
  assert.equal(res.statusCode, 200);

  const session = await authRepo.findSessionByToken(cookie.value);
  assert.ok(session, 'session must survive the renewal');
  const renewed = Date.parse(session.expiresAt);
  assert.ok(
    renewed > aged.getTime(),
    `expiry must move forward, got ${session.expiresAt}`
  );
  assert.ok(
    renewed > Date.now() + config.auth.sessionTtlMs * 0.9,
    'renewal must restore a full term, not a sliver'
  );

  const parsed = parseSetCookieFlags(
    getRawSetCookie(res.headers['set-cookie'])
  );
  assert.equal(parsed.name, config.auth.cookieName);
  assert.equal(parsed.value, cookie.value, 'the token itself must not change');
});

test('a fresh session is left alone, so ordinary requests do not rewrite it', async () => {
  const { user } = await seedUser();
  const cookie = await sessionCookieFor(user.id);

  const res = await meWith(cookie.value);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['set-cookie'], undefined);

  const session = await authRepo.findSessionByToken(cookie.value);
  assert.equal(session?.expiresAt, cookie.expiresAt);
});

test('an expired session is refused and cleared', async () => {
  const { user } = await seedUser();
  const cookie = await sessionCookieFor(user.id);
  await authRepo.extendSession(
    cookie.value,
    new Date(Date.now() - 1000).toISOString()
  );

  const res = await meWith(cookie.value);
  assert.equal(res.statusCode, 401);
  assert.equal(await authRepo.findSessionByToken(cookie.value), null);
});
