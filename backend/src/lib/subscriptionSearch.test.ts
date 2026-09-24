import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { normalizeSubscriptionSearch } from './subscriptionSearch';

test('preserves spaces and comparison operators in subscription searches', () => {
  assert.equal(
    normalizeSubscriptionSearch('  Red_Fox   score:>10  '),
    'red_fox score:>10'
  );
});
