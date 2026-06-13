// Unit contract for the SSRF guard. Literal IPs keep it fully offline:
// net.isIP() short-circuits the DNS lookup, so no network, no flake.
import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import {
  assertUrlAllowed,
  SsrfBlockedError,
  validatingLookup
} from '../src/lib/ssrfGuard';

// dns.lookup of a literal IP resolves to that IP without a network query, so
// these stay offline. Wraps validatingLookup's callback for both shapes.
const runLookup = (
  host: string,
  all: boolean
): Promise<{ err: Error | null; result: unknown }> =>
  new Promise((resolve) => {
    validatingLookup(
      host,
      { all } as never,
      ((err: Error | null, a: unknown, b: unknown) => {
        resolve({ err, result: all ? a : { address: a, family: b } });
      }) as never
    );
  });

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

test('validatingLookup blocks a private address (both callback shapes)', async () => {
  const single = await runLookup('127.0.0.1', false);
  assert.ok(single.err instanceof SsrfBlockedError);
  const all = await runLookup('127.0.0.1', true);
  assert.ok(all.err instanceof SsrfBlockedError);
});

test('validatingLookup returns the array shape when all:true', async () => {
  const { err, result } = await runLookup('8.8.8.8', true);
  assert.equal(err, null);
  assert.deepEqual(result, [{ address: '8.8.8.8', family: 4 }]);
});

test('validatingLookup returns the triple shape when all:false', async () => {
  const { err, result } = await runLookup('8.8.8.8', false);
  assert.equal(err, null);
  assert.deepEqual(result, { address: '8.8.8.8', family: 4 });
});
