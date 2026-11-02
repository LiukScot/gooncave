const assert = require('node:assert/strict');
const test = require('node:test');

const { isAppUri } = require('./links');

test('only the app origin and its blobs stay inside the window', () => {
  const origin = 'http://127.0.0.1:39761';
  assert.ok(isAppUri('http://127.0.0.1:39761', origin));
  assert.ok(isAppUri('http://127.0.0.1:39761/app/gallery', origin));
  assert.ok(isAppUri('blob:http://127.0.0.1:39761/8f3c', origin));
  assert.ok(!isAppUri('http://127.0.0.1:397610/', origin));
  assert.ok(!isAppUri('http://127.0.0.1:39761@evil.test/', origin));
  assert.ok(!isAppUri('https://e621.net/posts/1', origin));
  assert.ok(!isAppUri('blob:https://e621.net/8f3c', origin));
});
