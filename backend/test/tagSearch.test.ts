// The tag database end to end: aliases collapsing two vocabularies onto one
// tag, implications widening a search, the booru operators, and removing a
// tag by hand. Unit coverage of the pieces lives next to them in src/lib.
import './helpers/setupEnv';

import assert from 'node:assert/strict';

import { afterAll, beforeAll, beforeEach, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';

import { sqlite } from '../src/db/client';
import { filesRepo } from '../src/db/repos/filesRepo';
import { foldersRepo } from '../src/db/repos/foldersRepo';
import { tagDbRepo } from '../src/db/repos/tagDbRepo';
import { invalidateAliasCache, recanonicaliseAll } from '../src/services/tagDb';

import {
  buildTestApp,
  registerFixtureFile,
  seedUser,
  sessionCookieFor,
  writeFixtureFile
} from './helpers/testApp';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  sqlite.prepare('DELETE FROM tag_aliases').run();
  sqlite.prepare('DELETE FROM tag_implications').run();
  invalidateAliasCache();
});

const cookieFor = async (userId: string) => {
  const session = await sessionCookieFor(userId);
  return `${session.name}=${session.value}`;
};

/**
 * A user with one file per tag set, and the cookie to query as them. Tags
 * are stored as WD14 output rather than manual entries: the two are removed
 * differently, and provider tags are what the library is mostly made of.
 */
const seedLibrary = async (
  username: string,
  tagSets: string[][],
  source: 'WD14' | 'MANUAL' = 'WD14'
) => {
  const seeded = await seedUser({ username });
  const folders = await foldersRepo.listFolders(seeded.user.id);
  const files = [];
  for (const [index, tags] of tagSets.entries()) {
    const filePath = writeFixtureFile(
      folders[0].path,
      `${username}-${index}.png`,
      Buffer.from('x')
    );
    const file = await registerFixtureFile(folders[0].id, filePath);
    if (source === 'MANUAL') {
      for (const tag of tags) {
        await filesRepo.addManualTag(file.id, tag, 'general');
      }
    } else {
      await filesRepo.replaceTagsForSource(
        file.id,
        source,
        tags.map((tag) => ({ tag, category: 'general' }))
      );
    }
    files.push(file);
  }
  return { ...seeded, files, cookie: await cookieFor(seeded.user.id) };
};

const search = async (cookie: string, tags: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/files?tags=${encodeURIComponent(tags)}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { files: { path: string }[]; total: number }).total;
};

const setAliases = (pairs: [string, string][]) => {
  tagDbRepo.replaceImportedAliases(
    pairs.map(([antecedent, consequent]) => ({ antecedent, consequent }))
  );
  recanonicaliseAll();
};

const setImplications = (pairs: [string, string[]][]) => {
  tagDbRepo.replaceImplications(
    new Map(pairs.map(([tag, implied]) => [tag, new Set(implied)]))
  );
};

test('an alias makes both spellings find the same files', async () => {
  const lib = await seedLibrary('tagsearch_alias', [['1girls'], ['female']]);
  assert.equal(await search(lib.cookie, 'female'), 1);

  setAliases([['1girls', 'female']]);

  assert.equal(await search(lib.cookie, 'female'), 2);
  assert.equal(await search(lib.cookie, '1girls'), 2);
});

test('an alias added after the tags were stored still applies', async () => {
  // The file is tagged before the alias exists, so this only passes if the
  // import re-derives canonical_tag for rows that are already there.
  const lib = await seedLibrary('tagsearch_backfill', [['2girls']]);
  assert.equal(await search(lib.cookie, 'female'), 0);

  setAliases([['2girls', 'female']]);

  assert.equal(await search(lib.cookie, 'female'), 1);
});

test('an implication widens a search without touching the stored tag', async () => {
  const lib = await seedLibrary('tagsearch_implied', [['husky'], ['cat']]);
  setImplications([
    ['husky', ['dog', 'canine']],
    ['cat', ['feline']]
  ]);

  assert.equal(await search(lib.cookie, 'canine'), 1);
  assert.equal(await search(lib.cookie, 'husky'), 1);
  assert.equal(await search(lib.cookie, 'feline'), 1);

  const res = await app.inject({
    method: 'GET',
    url: `/files/${lib.files[0].id}/tags`,
    headers: { cookie: lib.cookie }
  });
  const body = res.json() as { tags: { tag: string }[]; implied: string[] };
  assert.deepEqual(
    body.tags.map((tag) => tag.tag),
    ['husky']
  );
  assert.deepEqual(body.implied, ['canine', 'dog']);
});

test('bare terms are required, ~ is an alternative and - excludes', async () => {
  const lib = await seedLibrary('tagsearch_operators', [
    ['female', 'solo'],
    ['male', 'solo'],
    ['female', 'male']
  ]);

  assert.equal(await search(lib.cookie, 'female'), 2);
  assert.equal(await search(lib.cookie, 'female male'), 1);
  assert.equal(await search(lib.cookie, '~female ~male'), 3);
  assert.equal(await search(lib.cookie, 'female -male'), 1);
  assert.equal(await search(lib.cookie, '-solo'), 1);
  assert.equal(await search(lib.cookie, 'solo -female'), 1);
});

test('operators read the alias table like bare terms do', async () => {
  const lib = await seedLibrary('tagsearch_operator_alias', [
    ['1girls'],
    ['male']
  ]);
  setAliases([['1girls', 'female']]);

  assert.equal(await search(lib.cookie, '-1girls'), 1);
  assert.equal(await search(lib.cookie, '~1girls ~male'), 2);
});

test('a removed tag drops out of search and comes back on refresh', async () => {
  const lib = await seedLibrary('tagsearch_suppress', [['1girls'], ['female']]);
  setAliases([['1girls', 'female']]);
  assert.equal(await search(lib.cookie, 'female'), 2);

  // The pill showed `female`; removing it has to take `1girls` with it.
  const removed = await app.inject({
    method: 'POST',
    url: `/files/${lib.files[0].id}/tags/suppress`,
    headers: { cookie: lib.cookie },
    payload: { tags: ['female'] }
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual((removed.json() as { tags: unknown[] }).tags, []);
  assert.equal(await search(lib.cookie, 'female'), 1);

  tagDbRepo.clearSuppressions(lib.files[0].id);
  assert.equal(await search(lib.cookie, 'female'), 2);
});

test('suppressing a tag on one file leaves the others alone', async () => {
  const lib = await seedLibrary('tagsearch_suppress_scope', [
    ['female'],
    ['female']
  ]);
  await app.inject({
    method: 'POST',
    url: `/files/${lib.files[0].id}/tags/suppress`,
    headers: { cookie: lib.cookie },
    payload: { tags: ['female'] }
  });

  const other = await app.inject({
    method: 'GET',
    url: `/files/${lib.files[1].id}/tags`,
    headers: { cookie: lib.cookie }
  });
  assert.deepEqual(
    (other.json() as { tags: { tag: string }[] }).tags.map((tag) => tag.tag),
    ['female']
  );
});

test('a manual tag is deleted outright, not suppressed', async () => {
  // Nothing re-fetches a hand-typed tag, so a suppression would let the
  // refresh button resurrect one the user deliberately removed.
  const lib = await seedLibrary(
    'tagsearch_manual_delete',
    [['typo']],
    'MANUAL'
  );
  await app.inject({
    method: 'POST',
    url: `/files/${lib.files[0].id}/tags/suppress`,
    headers: { cookie: lib.cookie },
    payload: { tags: ['typo'] }
  });

  tagDbRepo.clearSuppressions(lib.files[0].id);
  const after = await app.inject({
    method: 'GET',
    url: `/files/${lib.files[0].id}/tags`,
    headers: { cookie: lib.cookie }
  });
  assert.deepEqual((after.json() as { tags: unknown[] }).tags, []);
});

test('suppress rejects a file the caller does not own', async () => {
  const owner = await seedLibrary('tagsearch_owner', [['female']]);
  const stranger = await seedUser({ username: 'tagsearch_stranger' });
  const res = await app.inject({
    method: 'POST',
    url: `/files/${owner.files[0].id}/tags/suppress`,
    headers: { cookie: await cookieFor(stranger.user.id) },
    payload: { tags: ['female'] }
  });
  assert.equal(res.statusCode, 404);
});
