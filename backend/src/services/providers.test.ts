import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTrustedSaucePostUrl, pickSauceUrl } from './providers';

test('isTrustedSaucePostUrl accepts canonical e621 post URLs', () => {
  assert.equal(
    isTrustedSaucePostUrl('https://e621.net/posts/12345', 'e621.net'),
    true
  );
  assert.equal(
    isTrustedSaucePostUrl(
      'https://e621.net/post/show/12345?foo=bar',
      'e621.net'
    ),
    true
  );
});

test('isTrustedSaucePostUrl rejects host-lookalike URLs', () => {
  assert.equal(
    isTrustedSaucePostUrl(
      'https://e621.net.evil.example/posts/12345',
      'e621.net'
    ),
    false
  );
  assert.equal(
    isTrustedSaucePostUrl(
      'https://evil.example/e621.net/posts/12345',
      'e621.net'
    ),
    false
  );
});

test('isTrustedSaucePostUrl rejects non-http URL schemes', () => {
  assert.equal(
    isTrustedSaucePostUrl('javascript://e621.net/posts/12345', 'e621.net'),
    false
  );
  assert.equal(
    isTrustedSaucePostUrl('data://e621.net/posts/12345', 'e621.net'),
    false
  );
});

test('pickSauceUrl prefers trusted host-matching URLs over lookalikes', () => {
  const picked = pickSauceUrl([
    'https://e621.net.evil.example/posts/9',
    'https://danbooru.donmai.us/posts/10',
    'https://e621.net/posts/11'
  ]);
  assert.equal(picked, 'https://e621.net/posts/11');
});
