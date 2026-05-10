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

test('CORS allows preflight from configured origin', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: {
      origin: 'http://allowed.test',
      'access-control-request-method': 'GET'
    }
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], 'http://allowed.test');
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
});

test('CORS rejects origin not in allowlist', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/health',
    headers: {
      origin: 'http://evil.example',
      'access-control-request-method': 'GET'
    }
  });
  // @fastify/cors omits ACAO when origin is not allowed; browser will block.
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
