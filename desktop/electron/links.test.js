const assert = require('node:assert/strict');
const test = require('node:test');

const { isAppUri, openFolderPath } = require('./links');

test('open-folder links carry a decoded path from the app only', () => {
  const origin = 'http://127.0.0.1:4000';
  assert.equal(
    openFolderPath('http://127.0.0.1:4000/open-folder?path=%2Fhome%2Fme%2FMy%20Library%231', origin),
    '/home/me/My Library#1'
  );
  assert.equal(openFolderPath('https://evil.test/open-folder?path=%2F', origin), null);
  assert.equal(openFolderPath('http://127.0.0.1:4000/app/gallery', origin), null);
});

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
