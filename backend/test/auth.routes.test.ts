import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildTestApp } from './helpers/testApp';

let app: FastifyInstance;

before(async () => {
  app = await buildTestApp();
});

after(async () => {
  await app.close();
});

const parseSetCookieFlags = (raw: string) => {
  const parts = raw.split(';').map((p) => p.trim());
  const [namePair, ...flagParts] = parts;
  const [name, value] = namePair.split('=');
  const flags = new Set(flagParts.map((f) => f.toLowerCase().split('=')[0]));
  const sameSite = flagParts
    .map((f) => f.toLowerCase())
    .find((f) => f.startsWith('samesite='))
    ?.split('=')[1];
  return { name, value, flags, sameSite };
};

test('POST /auth/register creates user and sets HttpOnly+Lax cookie', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'alice_1', password: 'hunter2hunter2' }
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.user.username, 'alice_1');
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'expected Set-Cookie');
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const parsed = parseSetCookieFlags(raw);
  assert.equal(parsed.name, 'gooncave_session');
  assert.ok(parsed.flags.has('httponly'), 'cookie missing HttpOnly');
  assert.equal(parsed.sameSite, 'lax');
  // NODE_ENV=test → cookieSecure should default to false. This is the
  // regression guard for #67 (Secure cookie on plain HTTP locked users out).
  assert.equal(parsed.flags.has('secure'), false, 'Secure must be off in non-prod');
});

test('POST /auth/register rejects short username with 400', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'ab', password: 'longenoughpassword' }
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/register rejects duplicate username', async () => {
  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'dupuser', password: 'longenoughpassword' }
  });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'dupuser', password: 'longenoughpassword' }
  });
  assert.equal(res.statusCode, 400);
});

test('POST /auth/login wrong password returns 401', async () => {
  await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'bob_1', password: 'rightpassword1' }
  });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'bob_1', password: 'wrongpassword' }
  });
  assert.equal(res.statusCode, 401);
});

test('GET /auth/me without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/auth/me' });
  assert.equal(res.statusCode, 401);
});

test('GET /auth/me with valid cookie returns user', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'charlie_1', password: 'longenoughpassword' }
  });
  const setCookie = reg.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  const cookieValue = raw.split(';')[0];
  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { cookie: cookieValue }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().user.username, 'charlie_1');
});

test('Protected /folders without cookie returns 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/folders' });
  assert.equal(res.statusCode, 401);
});

test('POST /auth/logout clears cookie', async () => {
  const reg = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username: 'logout_user', password: 'longenoughpassword' }
  });
  const cookieValue = (reg.headers['set-cookie'] as string).split(';')[0];
  const res = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { cookie: cookieValue }
  });
  assert.equal(res.statusCode, 200);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
  // Clearing a cookie sets value to empty + Expires in past.
  assert.match(raw, /gooncave_session=;/);
});
