// Unit contract for the SSRF guard. Literal IPs keep it fully offline:
// net.isIP() short-circuits the DNS lookup, so no network, no flake.
import './helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertUrlAllowed, SsrfBlockedError } from '../src/lib/ssrfGuard';

const expectBlocked = async (rawUrl: string) => {
  await assert.rejects(
    () => assertUrlAllowed(rawUrl),
    (err: unknown) => err instanceof SsrfBlockedError,
    `expected ${rawUrl} to be blocked`
  );
};

test('blocks IPv4 loopback', async () => {
  await expectBlocked('http://127.0.0.1/posts.json');
});

test('blocks RFC-1918 private ranges', async () => {
  await expectBlocked('http://10.0.0.5/');
  await expectBlocked('http://192.168.1.10:8080/');
  await expectBlocked('http://172.16.5.4/');
});

test('blocks the cloud metadata link-local address', async () => {
  await expectBlocked('http://169.254.169.254/latest/meta-data/');
});

test('blocks IPv6 loopback and IPv4-mapped loopback', async () => {
  await expectBlocked('http://[::1]/');
  await expectBlocked('http://[::ffff:127.0.0.1]/');
});

test('blocks non-http(s) protocols', async () => {
  await expectBlocked('ftp://8.8.8.8/');
  await expectBlocked('file:///etc/passwd');
});

test('blocks an unparseable URL', async () => {
  await expectBlocked('not-a-url');
});

test('allows a public unicast address', async () => {
  await assert.doesNotReject(() => assertUrlAllowed('https://8.8.8.8/'));
});
