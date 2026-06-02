// Detection is the riskiest new logic (AGENTS.md §9): hostname lookup, a
// parallel probe race, JSON-vs-XML body dispatch, and unreachable-vs-unknown
// classification. We pin it with a fetch mock so no real network is hit.
import '../../../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  armFetchMock,
  disarmFetchMock,
  type FetchMock
} from '../../../test/helpers/fetchMock';

import { detectEngine } from './detect';

let fetchMock: FetchMock;

beforeEach(() => {
  // These tests use fake hostnames with a mocked network; the SSRF guard
  // (which does a real DNS lookup) is orthogonal here and covered by
  // ssrfGuard.test.ts. Opt out so safeFetch passes straight to the mock.
  process.env.ALLOW_PRIVATE_BOORU_HOSTS = 'true';
  fetchMock = armFetchMock();
});

afterEach(() => {
  disarmFetchMock();
  delete process.env.ALLOW_PRIVATE_BOORU_HOSTS;
});

// Helper: reply 200 with the given JSON to the engine's probe path. Persistent
// because some engines share a probe path (e621 and danbooru both GET
// /posts.json?limit=1); both requests must receive the same body so the shape
// check decides the winner, not request ordering.
const replyJson = (path: string, body: unknown) => {
  fetchMock.intercept((url) => url.includes(path), {
    status: 200,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    persist: true
  });
};

test('detectEngine identifies danbooru by its probe shape', async () => {
  const origin = 'https://booru.example.com';
  // danbooru probe path is /posts.json?limit=1; reply with the flat
  // tag_string_general shape only danbooru matches.
  replyJson('/posts.json?limit=1', [
    { id: 5, tag_string_general: 'cat dog', preview_file_url: '/p/5.jpg' }
  ]);
  // Every other engine probe on this origin 404s.
  fetchMock.intercept(() => true, { status: 404, body: '', persist: true });

  const result = await detectEngine(origin);
  assert.ok(
    'engine' in result,
    `expected success, got ${JSON.stringify(result)}`
  );
  if ('engine' in result) {
    assert.equal(result.engine, 'danbooru');
    assert.equal(result.confidence, 'probe');
    assert.equal(result.sample?.postId, '5');
  }
});

test('detectEngine returns unknown when every engine responds 200 but none match', async () => {
  const origin = 'https://mystery.example.com';
  // All probe paths reply 200 with a body no engine recognizes.
  fetchMock.intercept(() => true, {
    status: 200,
    body: JSON.stringify({ unrelated: true }),
    headers: { 'content-type': 'application/json' },
    persist: true
  });

  const result = await detectEngine(origin);
  assert.ok('error' in result);
  if ('error' in result) {
    assert.equal(result.error, 'unknown');
    assert.ok(result.attempts.length > 0);
    assert.ok(result.attempts.every((a) => a.status === 'no-match'));
  }
});

test('detectEngine returns unreachable when no engine gets an HTTP reply', async () => {
  // No intercepts registered + disableNetConnect => every probe rejects at the
  // network level, which must classify as unreachable, not unknown.
  const result = await detectEngine('https://offline.example.com');
  assert.ok('error' in result);
  if ('error' in result) {
    assert.equal(result.error, 'unreachable');
  }
});

test('detectEngine rejects non-http(s) URLs without probing', async () => {
  const result = await detectEngine('ftp://example.com');
  assert.ok('error' in result);
  if ('error' in result) {
    assert.equal(result.error, 'unknown');
    assert.equal(result.attempts.length, 0);
  }
});

test('detectEngine uses hostname lookup for known hosts (confidence: hostname)', async () => {
  // e621.net is in HOSTNAME_MAP. The hostname path still probes for a sample;
  // reply with a valid e621 body so the sample is populated.
  replyJson('/posts.json?limit=1', {
    posts: [{ id: 7, preview: { url: '/p/7.jpg' }, tags: { general: ['cat'] } }]
  });
  const result = await detectEngine('https://e621.net');
  assert.ok('engine' in result);
  if ('engine' in result) {
    assert.equal(result.engine, 'e621');
    assert.equal(result.confidence, 'hostname');
    assert.equal(result.sample?.postId, '7');
  }
});
