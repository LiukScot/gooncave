const assert = require('node:assert/strict');
const test = require('node:test');

const { isAppUri, linkTarget } = require('./links');

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

test('an open-folder link opens the file manager instead of loading in the window', () => {
  const origin = 'http://127.0.0.1:39761';
  assert.deepEqual(linkTarget('http://127.0.0.1:39761/open-folder?path=%2Fhome%2Fme%2FMy%20Library%231', origin), {
    kind: 'folder',
    path: '/home/me/My Library#1'
  });
  assert.deepEqual(linkTarget('http://127.0.0.1:39761/open-folder?path=%E0%A4%A', origin), { kind: 'none' });
  assert.deepEqual(linkTarget('https://evil.test/open-folder?path=%2F', origin), { kind: 'outside' });
  assert.deepEqual(linkTarget('http://127.0.0.1:39761/app/gallery', origin), { kind: 'app' });
});
