// Pin the credential resolver. No HTTP — credentials live in the DB or
// nowhere, and resolveCredential is the one place that's allowed to know.
import '../../test/helpers/setupEnv';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seedUser } from '../../test/helpers/testApp';
import { dataStore } from '../lib/dataStore';

import { resolveCredential, resolveCredentials } from './credentials';

test('resolveCredential returns "none" source when no userId is supplied', async () => {
  const result = await resolveCredential('E621');
  assert.equal(result.provider, 'E621');
  assert.equal(result.username, null);
  assert.equal(result.apiKey, null);
  assert.equal(result.source, 'none');
});

test('resolveCredential returns "none" when the user has no stored credential', async () => {
  const seeded = await seedUser({ username: 'cred_empty' });
  const result = await resolveCredential('DANBOORU', seeded.user.id);
  assert.equal(result.source, 'none');
  assert.equal(result.username, null);
  assert.equal(result.apiKey, null);
});

test('resolveCredential returns "db" source when a credential exists', async () => {
  const seeded = await seedUser({ username: 'cred_set' });
  await dataStore.upsertCredential('E621', { username: 'alice', apiKey: 'secret' }, seeded.user.id);
  const result = await resolveCredential('E621', seeded.user.id);
  assert.equal(result.source, 'db');
  assert.equal(result.username, 'alice');
  assert.equal(result.apiKey, 'secret');
  assert.ok(result.updatedAt, 'updatedAt is set when persisted');
});

test('resolveCredentials preserves provider order', async () => {
  const seeded = await seedUser({ username: 'cred_order' });
  const providers = ['SAUCENAO', 'E621', 'DANBOORU'] as const;
  const result = await resolveCredentials([...providers], seeded.user.id);
  assert.deepEqual(result.map((r) => r.provider), [...providers]);
});

test('resolveCredentials isolates one user from another', async () => {
  const alice = await seedUser({ username: 'cred_alice' });
  const bob = await seedUser({ username: 'cred_bob' });
  await dataStore.upsertCredential('SAUCENAO', { username: 'alice@s', apiKey: 'A' }, alice.user.id);
  const bobResult = await resolveCredential('SAUCENAO', bob.user.id);
  // Bob never saved a credential; Alice's must NOT leak.
  assert.equal(bobResult.source, 'none');
  assert.equal(bobResult.username, null);
});
