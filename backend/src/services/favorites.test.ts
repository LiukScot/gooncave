import fs from 'fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'path';

import { extractFavoriteRemoteFromSourceUrl } from '../lib/favoriteSourceMatch';

test('extractFavoriteRemoteFromSourceUrl returns E621 + remoteId for e621 post URL', () => {
  const result = extractFavoriteRemoteFromSourceUrl('https://e621.net/posts/12345');
  assert.deepEqual(result, { provider: 'E621', remoteId: '12345' });
});

test('extractFavoriteRemoteFromSourceUrl handles trailing path/query', () => {
  const result = extractFavoriteRemoteFromSourceUrl('https://e621.net/posts/98765?q=foo#bar');
  assert.deepEqual(result, { provider: 'E621', remoteId: '98765' });
});

test('extractFavoriteRemoteFromSourceUrl returns DANBOORU for danbooru post URL', () => {
  const result = extractFavoriteRemoteFromSourceUrl('https://danbooru.donmai.us/posts/42');
  assert.deepEqual(result, { provider: 'DANBOORU', remoteId: '42' });
});

test('extractFavoriteRemoteFromSourceUrl rejects non-post URLs', () => {
  assert.equal(extractFavoriteRemoteFromSourceUrl('https://e621.net/users/me'), null);
  assert.equal(extractFavoriteRemoteFromSourceUrl('https://example.com/posts/1'), null);
});

test('extractFavoriteRemoteFromSourceUrl handles null/empty input', () => {
  assert.equal(extractFavoriteRemoteFromSourceUrl(null), null);
  assert.equal(extractFavoriteRemoteFromSourceUrl(''), null);
  assert.equal(extractFavoriteRemoteFromSourceUrl(undefined), null);
});

// Static safety guarantee for #66 option C: the favorites sync engine must
// never call the unfavorite primitives. If this test breaks, someone wired
// reverse-sync into sync — see the comment above `syncProvider` for why
// that creates an auto-fav loop.
test('syncProvider source contains no reverse-sync calls', () => {
  const source = fs.readFileSync(path.join(__dirname, 'favorites.ts'), 'utf8');
  const start = source.indexOf('const syncProvider = async');
  assert.notEqual(start, -1, 'expected to find syncProvider declaration');
  // Walk braces from the function's opening `{` to its matching close.
  const openBraceIndex = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, 'failed to find end of syncProvider body');
  const body = source.slice(start, end + 1);
  for (const forbidden of ['removeFavorite', 'unfavoriteE621', 'unfavoriteDanbooru']) {
    assert.equal(
      body.includes(forbidden),
      false,
      `syncProvider must not reference ${forbidden} (auto-fav loop risk — see #66)`
    );
  }
});
