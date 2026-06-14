// Pure-function contract for the booru engine helpers. The redaction helper is
// a security boundary (issue #200 finding 1): credential query params must
// never survive into a log line or a client-facing error.
import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { redactUrlSecrets } from '../src/lib/booruEngines/helpers';

test('redactUrlSecrets masks api_key in a bare URL', () => {
  const url =
    'https://gelbooru.com/index.php?page=dapi&user_id=42&api_key=SECRET123';
  const out = redactUrlSecrets(url);
  assert.equal(
    out,
    'https://gelbooru.com/index.php?page=dapi&user_id=42&api_key=***'
  );
  assert.ok(!out.includes('SECRET123'));
});

test('redactUrlSecrets keeps non-secret params intact', () => {
  const url = 'https://gelbooru.com/index.php?page=dapi&user_id=42&id=99';
  assert.equal(redactUrlSecrets(url), url);
});

test('redactUrlSecrets masks api_key when it is the first param', () => {
  const url = 'https://booru.example/posts.json?api_key=abc&page=1';
  assert.equal(
    redactUrlSecrets(url),
    'https://booru.example/posts.json?api_key=***&page=1'
  );
});

test('redactUrlSecrets masks pass_hash, login and token', () => {
  const url =
    'https://booru.example/?login=user&pass_hash=deadbeef&token=zzz&q=cat';
  assert.equal(
    redactUrlSecrets(url),
    'https://booru.example/?login=***&pass_hash=***&token=***&q=cat'
  );
});

test('redactUrlSecrets redacts a URL embedded in an error message', () => {
  const message =
    'fetch failed: https://gelbooru.com/index.php?api_key=TOPSECRET&id=1 (ECONNREFUSED)';
  const out = redactUrlSecrets(message);
  assert.ok(!out.includes('TOPSECRET'));
  assert.ok(out.includes('api_key=***'));
  assert.ok(out.includes('(ECONNREFUSED)'));
});

test('redactUrlSecrets is case-insensitive on the key', () => {
  const url = 'https://booru.example/?API_KEY=secret';
  assert.equal(redactUrlSecrets(url), 'https://booru.example/?API_KEY=***');
});
