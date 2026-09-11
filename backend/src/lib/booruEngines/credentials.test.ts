import assert from 'node:assert/strict';

import { test } from 'bun:test';

import type { BooruEngineType, BooruSiteRecord } from '../../db/types';

import {
  engineCredentialError,
  engineCredentialsReady
} from './index';

const site = (
  engine: BooruEngineType,
  overrides: Partial<BooruSiteRecord> = {}
): BooruSiteRecord => ({
  id: `site-${engine}`,
  userId: 'user-1',
  name: engine,
  engine,
  baseUrl: 'https://example.com',
  username: null,
  apiKey: null,
  sessionCookie: null,
  isPreset: false,
  presetKey: null,
  enabled: true,
  siteAutoSyncMidnight: false,
  siteReverseSyncEnabled: false,
  siteAutoFavEnabled: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides
});

test('credential readiness follows each engine credential schema', () => {
  assert.equal(
    engineCredentialsReady(
      site('e621', { username: 'demo', apiKey: 'secret' })
    ),
    true
  );
  assert.equal(engineCredentialsReady(site('e621', { username: 'demo' })), false);
  assert.equal(
    engineCredentialsReady(site('philomena', { apiKey: 'secret' })),
    true
  );
  assert.equal(engineCredentialsReady(site('sankaku', { apiKey: 'token' })), true);
  assert.equal(engineCredentialsReady(site('moebooru')), true);
  assert.equal(
    engineCredentialsReady(
      site('furaffinity', {
        username: 'demo',
        sessionCookie: 'a=account; b=session'
      })
    ),
    true
  );
  assert.equal(
    engineCredentialsReady(site('furaffinity', { username: 'demo' })),
    false
  );
});

test('credential errors name the fields the selected engine actually needs', () => {
  assert.match(engineCredentialError(site('e621')) ?? '', /username and API key/i);
  assert.match(
    engineCredentialError(site('furaffinity')) ?? '',
    /username and session cookie/i
  );
  assert.equal(engineCredentialError(site('moebooru')), null);
});
