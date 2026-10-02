import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import {
  disarmFetchMock,
  setupFetchMock
} from '../../../test/helpers/fetchMock';

import { politeFetch, politeRetry } from './politeFetch';

// The shared fetch mock zeroes the waits for every test.
const testDelays = politeRetry.delaysMs;

afterEach(() => {
  disarmFetchMock();
  politeRetry.delaysMs = testDelays;
});

const CHALLENGE = '<script src="/cdn-cgi/challenge-platform/x"></script>';

test('a refusal that outlasts every retry is handed back as it is', async () => {
  const fm = setupFetchMock();
  let requests = 0;
  fm.intercept(() => true, {
    status: 429,
    body: 'slow down',
    persist: true,
    onStart: () => (requests += 1)
  });

  const res = await politeFetch('https://limited.example/a');

  assert.equal(res.status, 429);
  assert.equal(await res.text(), 'slow down');
  assert.equal(requests, 4, 'one request plus one per delay');
});

test('a CAPTCHA page is retried, a plain refusal is not', async () => {
  const fm = setupFetchMock();
  let requests = 0;
  const count = () => (requests += 1);
  fm.intercept((url) => url.endsWith('/captcha'), {
    status: 403,
    body: CHALLENGE,
    onStart: count
  });
  fm.intercept((url) => url.endsWith('/captcha'), {
    status: 200,
    body: 'ok',
    onStart: count
  });
  fm.intercept((url) => url.endsWith('/forbidden'), {
    status: 403,
    body: 'forbidden',
    persist: true,
    onStart: count
  });

  assert.equal((await politeFetch('https://captcha.example/captcha')).status, 200);
  assert.equal(requests, 2);
  assert.equal((await politeFetch('https://captcha.example/forbidden')).status, 403);
  assert.equal(requests, 3);
});

test('a pause covers every request to that host and no other', async () => {
  politeRetry.delaysMs = [150];
  const fm = setupFetchMock();
  fm.intercept((url) => url.includes('busy.example/first'), {
    status: 429,
    body: ''
  });
  fm.intercept(() => true, { status: 200, body: 'ok', persist: true });

  const started = Date.now();
  const first = politeFetch('https://busy.example/first');
  // Let the first request come back refused before the others start.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finished: string[] = [];
  let sameHostMs = 0;
  await Promise.all([
    first,
    politeFetch('https://busy.example/second').then(() => {
      sameHostMs = Date.now() - started;
      finished.push('same host');
    }),
    politeFetch('https://calm.example/x').then(() => finished.push('other host'))
  ]);

  // Order, not an upper bound on elapsed time: a loaded machine stretches
  // every duration but cannot make a timer fire early.
  assert.deepEqual(finished, ['other host', 'same host']);
  assert.ok(sameHostMs >= 140, `same host only waited ${sameHostMs}ms`);
});
