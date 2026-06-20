import assert from 'node:assert/strict';

import { test } from 'bun:test';

import {
  PROVIDER_MATCH_THRESHOLDS,
  providerMatchThreshold
} from './providerThresholds';

test('providerMatchThreshold returns SAUCENAO threshold', () => {
  assert.equal(providerMatchThreshold('SAUCENAO'), 90);
});

test('providerMatchThreshold returns FLUFFLE threshold', () => {
  assert.equal(providerMatchThreshold('FLUFFLE'), 95);
});

test('PROVIDER_MATCH_THRESHOLDS has expected values', () => {
  assert.equal(PROVIDER_MATCH_THRESHOLDS.SAUCENAO, 90);
  assert.equal(PROVIDER_MATCH_THRESHOLDS.FLUFFLE, 95);
});
