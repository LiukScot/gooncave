import { expect, it } from 'vitest';

import { queryRetryDelay, shouldRetryQuery } from './query-client';

it('retries a failed connection for as long as the server may take to restart', () => {
  const offline = new TypeError('Load failed');
  expect([0, 1, 2, 3].every((failures) => shouldRetryQuery(failures, offline))).toBe(true);
  expect(shouldRetryQuery(4, offline)).toBe(false);
  expect([0, 1, 2, 3].reduce((total, failures) => total + queryRetryDelay(failures), 0)).toBeGreaterThanOrEqual(15_000 - 1_000);
});

it('retries an error the server sent only once', () => {
  expect(shouldRetryQuery(0, new Error('Not found'))).toBe(true);
  expect(shouldRetryQuery(1, new Error('Not found'))).toBe(false);
});
