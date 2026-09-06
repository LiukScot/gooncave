import assert from 'node:assert/strict';

import { afterEach, test } from 'bun:test';

import { createTtlCache } from './ttlCache';

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

/** Moves the clock rather than sleeping: a TTL test should not cost its TTL. */
const atTime = (ms: number) => {
  Date.now = () => ms;
};

test('returns a value inside its time limit and drops it after', () => {
  const cache = createTtlCache<string>(1_000, 10);
  atTime(0);
  cache.set('a', 'kept');

  atTime(999);
  assert.equal(cache.get('a'), 'kept');

  atTime(1_001);
  assert.equal(cache.get('a'), null);
});

test('evicts the oldest key once the cap is reached', () => {
  const cache = createTtlCache<string>(1_000, 2);
  atTime(0);
  cache.set('first', '1');
  cache.set('second', '2');
  cache.set('third', '3');

  assert.equal(cache.get('first'), null);
  assert.equal(cache.get('second'), '2');
  assert.equal(cache.get('third'), '3');
});

test('overwriting a key at the cap evicts nothing', () => {
  const cache = createTtlCache<string>(1_000, 2);
  atTime(0);
  cache.set('first', '1');
  cache.set('second', '2');
  cache.set('second', 'again');

  assert.equal(cache.get('first'), '1');
  assert.equal(cache.get('second'), 'again');
});

test('a missing key is a miss, not a throw', () => {
  const cache = createTtlCache<string>(1_000, 2);
  assert.equal(cache.get('never-set'), null);
});
