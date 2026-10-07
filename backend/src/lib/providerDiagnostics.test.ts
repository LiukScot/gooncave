import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, test } from 'bun:test';
import Fastify from 'fastify';

import { disarmFetchMock, setupFetchMock } from '../../test/helpers/fetchMock';
import { config } from '../config';

import { politeFetch, politeRetry } from './booruEngines/politeFetch';
import {
  listProviderDiagnostics,
  registerProviderDiagnostics
} from './providerDiagnostics';

const originalDataFile = config.storage.dataFile;
const originalDelays = politeRetry.delaysMs;
let temporary = '';

test('developer mode gates capture and disabling it stops recording an in-flight request', async () => {
  let enabled = false;
  const app = await server(5, () => enabled);
  const mock = setupFetchMock();
  mock.intercept(() => true, { status: 403, body: 'forbidden' });
  mock.intercept(() => true, { status: 403, body: 'forbidden' });
  mock.intercept(() => true, { status: 403, body: 'forbidden', delayMs: 40, onStart: () => { enabled = false; } });
  try {
    await app.inject('/explore/posts');
    assert.deepEqual(await listProviderDiagnostics('reader'), []);
    enabled = true;
    await app.inject('/explore/posts');
    assert.equal((await listProviderDiagnostics('reader'))[0].count, 1);
    await app.inject('/explore/posts');
    const reports = await listProviderDiagnostics('reader');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].count, 1);
  } finally { await app.close(); }
});

test('bounds persistent history and excludes expired reports', async () => {
  const app = await server();
  setupFetchMock().intercept(() => true, { status: 403, body: 'forbidden', persist: true });
  try {
    await app.inject('/explore/posts');
    const [captured] = await listProviderDiagnostics('reader');
    const reports = Array.from({ length: 200 }, () => ({ ...captured, id: randomUUID(), userId: 'reader', operation: 'detail' }));
    const file = path.join(temporary, 'provider-diagnostics.json');
    await writeFile(file, JSON.stringify(reports));
    await app.inject('/explore/posts');
    const bounded = await listProviderDiagnostics('reader');
    assert.equal(bounded.length, 200);
    assert.ok(!bounded.some((report) => report.id === reports[0].id));
    assert.ok(Buffer.byteLength(await readFile(file, 'utf8')) <= 512 * 1024);
    await writeFile(file, JSON.stringify([{ ...reports[0], updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }]));
    assert.deepEqual(await listProviderDiagnostics('reader'), []);
  } finally { await app.close(); }
});
afterEach(async () => {
  disarmFetchMock();
  config.storage.dataFile = originalDataFile;
  politeRetry.delaysMs = originalDelays;
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function server(slowMs = 4_000, isEnabled = () => true) {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'provider-diagnostics-'));
  config.storage.dataFile = path.join(temporary, 'data.db');
  const app = Fastify();
  app.decorateRequest('currentUser', null);
  app.addHook('onRequest', async (request) => {
    request.currentUser = {
      id: 'reader',
      username: 'neutral',
      passwordHash: '',
      libraryRoot: '',
      createdAt: '',
      updatedAt: '',
      lastLoginAt: null
    };
  });
  registerProviderDiagnostics(app, isEnabled, slowMs);
  app.get('/explore/posts', async () => {
    await politeFetch(
      'https://rule34.xxx/index.php?api_key=SECRET&tags=PRIVATE',
      { headers: { Cookie: 'SECRET' } }
    );
    return { ok: true };
  });
  return app;
}

test('automatically records retries without credentials or searches and isolates accounts', async () => {
  const app = await server();
  const mock = setupFetchMock();
  mock.intercept(() => true, {
    status: 403,
    body: '<script src="/cdn-cgi/challenge-platform/x"></script>'
  });
  mock.intercept(() => true, { status: 200, body: 'PRIVATE BODY' });
  try {
    assert.equal((await app.inject('/explore/posts')).statusCode, 200);
    const reports = await listProviderDiagnostics('reader');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].challenges, 1);
    assert.equal(reports[0].retries, 1);
    assert.deepEqual(
      reports[0].attempts.map((attempt) => attempt.status),
      [403, 200]
    );
    assert.deepEqual(await listProviderDiagnostics('other-reader'), []);
    const stored = await readFile(
      path.join(temporary, 'provider-diagnostics.json'),
      'utf8'
    );
    assert.ok(
      !stored.includes('SECRET') &&
        !stored.includes('PRIVATE') &&
        !stored.includes('index.php')
    );
  } finally {
    await app.close();
  }
});

test('captures an unfinished slow request and updates it when it completes', async () => {
  const app = await server(5);
  setupFetchMock().intercept(() => true, {
    status: 200,
    body: 'ok',
    delayMs: 80
  });
  try {
    const pending = app.inject('/explore/posts');
    const completed = Promise.resolve(pending);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      (await listProviderDiagnostics('reader'))[0]?.outcome,
      'pending'
    );
    await completed;
    const reports = await listProviderDiagnostics('reader');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].outcome, 'completed');
    assert.equal(reports[0].attempts[0].status, 200);
  } finally {
    await app.close();
  }
});

test('fast successful requests do not create reports and repeated failures are grouped', async () => {
  const app = await server();
  const mock = setupFetchMock();
  mock.intercept(() => true, { status: 200 });
  mock.intercept(() => true, { status: 403, body: 'forbidden', persist: true });
  try {
    await app.inject('/explore/posts');
    assert.deepEqual(await listProviderDiagnostics('reader'), []);
    await app.inject('/explore/posts');
    await app.inject('/explore/posts');
    const reports = await listProviderDiagnostics('reader');
    assert.equal(reports.length, 1);
    assert.equal(reports[0].count, 2);
  } finally {
    await app.close();
  }
});

test('captures a shared pause before the search sends its first HTTP request', async () => {
  const app = await server(5);
  const mock = setupFetchMock();
  politeRetry.delaysMs = [120];
  mock.intercept((url) => url.endsWith('/pause'), { status: 429 });
  mock.intercept(() => true, { status: 200, persist: true });
  const blocker = politeFetch('https://rule34.xxx/pause');
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const search = Promise.resolve(app.inject('/explore/posts'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const report = (await listProviderDiagnostics('reader'))[0];
    assert.equal(report.outcome, 'pending');
    assert.equal(report.requestCount, 0);
    assert.deepEqual(report.providers, ['rule34.xxx']);
    assert.ok(report.sharedWaitMs > 0);
    await search;
    assert.equal((await listProviderDiagnostics('reader'))[0].requestCount, 1);
  } finally {
    await blocker;
    await app.close();
  }
});
