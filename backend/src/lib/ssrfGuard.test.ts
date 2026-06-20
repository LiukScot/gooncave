// Pin the SSRF guard: this is the most security-critical path in the codebase.
// Tests use IP literals only — no real DNS lookups occur.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { assertUrlAllowed, SsrfBlockedError } from './ssrfGuard';

const assertBlocked = async (url: string) => {
  await assert.rejects(
    () => assertUrlAllowed(url),
    (err: unknown) => err instanceof SsrfBlockedError
  );
};

test('allows a public HTTPS URL', async () => {
  // Uses a real public IP — assertUrlAllowed resolves DNS; for CI we use an
  // IP literal so no DNS query is made and the test is fully offline.
  await assert.doesNotReject(() => assertUrlAllowed('https://1.1.1.1/'));
});

test('blocks IPv4 loopback 127.0.0.1', async () => {
  await assertBlocked('http://127.0.0.1/');
});

test('blocks IPv4 loopback 127.0.0.2', async () => {
  await assertBlocked('http://127.0.0.2/secret');
});

test('blocks private range 10.x.x.x', async () => {
  await assertBlocked('http://10.0.0.1/');
});

test('blocks private range 192.168.x.x', async () => {
  await assertBlocked('http://192.168.1.1/');
});

test('blocks private range 172.16.x.x', async () => {
  await assertBlocked('http://172.16.0.1/');
});

test('blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1', async () => {
  await assertBlocked('http://[::ffff:127.0.0.1]/');
});

test('blocks IPv4-mapped IPv6 private ::ffff:192.168.1.1', async () => {
  await assertBlocked('http://[::ffff:192.168.1.1]/');
});

test('blocks IPv6 loopback ::1', async () => {
  await assertBlocked('http://[::1]/');
});

test('blocks non-http scheme', async () => {
  await assertBlocked('ftp://1.1.1.1/');
});

test('blocks invalid URL', async () => {
  await assertBlocked('not-a-url');
});
