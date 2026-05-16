// Pin the sauce-aggregation pure functions. No DB, no app — just inputs
// and outputs. These functions decide what shows up under "Sources" in
// the UI, so the test matrix doubles as documentation of canonicalization.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectSaucesFromRuns,
  extractSauceKey,
  extractSauceLabel,
  hasTargetSauce,
  normalizeSauceKey
} from './sauces';
import type { ProviderRunRecord } from './dataStore';

const baseRun: ProviderRunRecord = {
  id: 'run-1',
  fileId: 'file-1',
  provider: 'SAUCENAO',
  status: 'COMPLETED',
  cachedHit: false,
  score: 95,
  sourceUrl: null,
  thumbUrl: null,
  results: [],
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  error: null
};

const completedRun = (overrides: Partial<ProviderRunRecord>): ProviderRunRecord => ({
  ...baseRun,
  ...overrides,
  results: overrides.results ?? baseRun.results
});

test('normalizeSauceKey lowercases and trims', () => {
  assert.equal(normalizeSauceKey(' E621 '), 'e621');
});

test('extractSauceKey returns canonical e621 for static subdomain', () => {
  const key = extractSauceKey('https://static1.e621.net/data/cool.jpg', null);
  assert.equal(key, 'e621');
});

test('extractSauceKey returns canonical danbooru for www-prefixed URL', () => {
  const key = extractSauceKey('https://www.danbooru.donmai.us/posts/9', null);
  assert.equal(key, 'danbooru');
});

test('extractSauceKey ignores SAUCENAO/FLUFFLE self-references in sourceName', () => {
  // SAUCENAO/FLUFFLE strings would imply the provider is reporting itself
  // as a source. The aggregator must filter them out by name, otherwise
  // every SAUCENAO run would credit "saucenao" as a sauce.
  assert.equal(extractSauceKey(null, 'SauceNAO'), null);
  assert.equal(extractSauceKey(null, 'fluffle'), null);
});

test('extractSauceKey prefers a parseable sourceName over a URL', () => {
  const key = extractSauceKey('https://e621.net/posts/1', 'e621');
  assert.equal(key, 'e621');
});

test('extractSauceLabel returns hostname-style label for unknown sites', () => {
  const label = extractSauceLabel('https://example.org/posts/1', null);
  assert.equal(label, 'example.org');
});

test('collectSaucesFromRuns dedupes per file and ranks by count', () => {
  const runs: ProviderRunRecord[] = [
    completedRun({
      id: 'r1',
      fileId: 'file-A',
      results: [{ sourceUrl: 'https://e621.net/posts/1', score: 99, sourceName: null, thumbUrl: null }]
    }),
    completedRun({
      id: 'r2',
      fileId: 'file-A',
      // Same file, same key — counted ONCE.
      results: [{ sourceUrl: 'https://static2.e621.net/data/x', score: 99, sourceName: null, thumbUrl: null }]
    }),
    completedRun({
      id: 'r3',
      fileId: 'file-B',
      results: [{ sourceUrl: 'https://danbooru.donmai.us/posts/2', score: 99, sourceName: null, thumbUrl: null }]
    })
  ];
  const sources = collectSaucesFromRuns(runs);
  assert.deepEqual(
    sources.map((s) => ({ key: s.key, count: s.count })).sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: 'danbooru', count: 1 },
      { key: 'e621', count: 1 }
    ]
  );
});

test('collectSaucesFromRuns drops results below the SAUCENAO threshold', () => {
  const runs: ProviderRunRecord[] = [
    completedRun({
      id: 'r-low',
      fileId: 'file-X',
      results: [{ sourceUrl: 'https://e621.net/posts/1', score: 50, sourceName: null, thumbUrl: null }]
    })
  ];
  const sources = collectSaucesFromRuns(runs);
  assert.equal(sources.length, 0);
});

test('hasTargetSauce returns false when target set is empty (regardless of runs)', () => {
  const runs = [completedRun({ results: [{ sourceUrl: 'https://e621.net/posts/1', score: 99, sourceName: null, thumbUrl: null }] })];
  assert.equal(hasTargetSauce(runs, new Set()), false);
});

test('hasTargetSauce ignores still-running provider runs', () => {
  const runs = [completedRun({ status: 'RUNNING', results: [{ sourceUrl: 'https://e621.net/posts/1', score: 99, sourceName: null, thumbUrl: null }] })];
  assert.equal(hasTargetSauce(runs, new Set(['e621'])), false);
});

test('hasTargetSauce true when at least one completed run lists the target', () => {
  const runs = [completedRun({ results: [{ sourceUrl: 'https://danbooru.donmai.us/posts/2', score: 99, sourceName: null, thumbUrl: null }] })];
  assert.equal(hasTargetSauce(runs, new Set(['danbooru'])), true);
});
