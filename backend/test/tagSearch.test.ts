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
  sqlite.prepare('DELETE FROM tag_categories').run();
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
    pairs.map(([antecedent, consequent]) => ({
      antecedent,
      consequent,
      source: 'e621' as const
    }))
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

/** Votes are written straight in: applyFileVote enforces a cooldown and a
 *  floor at zero, and neither is what these assertions are about. */
const setScores = (fileIds: string[], scores: number[]) => {
  const stmt = sqlite.prepare(
    `INSERT INTO file_votes (file_id, score, last_vote_at)
     VALUES (?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET score = excluded.score`
  );
  fileIds.forEach((id, index) =>
    stmt.run(id, scores[index], new Date().toISOString())
  );
};

test('score: filters on the votes the file already has', async () => {
  const lib = await seedLibrary('tagsearch_score', [
    ['female'],
    ['female'],
    ['female']
  ]);
  setScores(
    lib.files.map((file) => file.id),
    [0, 3, 7]
  );

  assert.equal(await search(lib.cookie, 'score:>0'), 2);
  assert.equal(await search(lib.cookie, 'score:>=3'), 2);
  assert.equal(await search(lib.cookie, 'score:<3'), 1);
  assert.equal(await search(lib.cookie, 'score:<=3'), 2);
  assert.equal(await search(lib.cookie, 'score:3'), 1);
  assert.equal(await search(lib.cookie, 'score:=3'), 1);
});

test('a file nobody voted on reads as zero, like the vote control shows', async () => {
  const lib = await seedLibrary('tagsearch_score_unvoted', [['female']]);
  assert.equal(await search(lib.cookie, 'score:0'), 1);
  assert.equal(await search(lib.cookie, 'score:>0'), 0);
});

test('score: narrows itself into a range and combines with tags', async () => {
  const lib = await seedLibrary('tagsearch_score_range', [
    ['female'],
    ['female'],
    ['male']
  ]);
  setScores(
    lib.files.map((file) => file.id),
    [1, 9, 5]
  );

  // Scores are 1, 9 and 5: only the 5 sits inside both bounds.
  assert.equal(await search(lib.cookie, 'score:>1 score:<9'), 1);
  assert.equal(await search(lib.cookie, 'score:>0 score:<9'), 2);
  assert.equal(await search(lib.cookie, 'female score:>0'), 2);
  assert.equal(await search(lib.cookie, 'female score:>5'), 1);
  assert.equal(await search(lib.cookie, '-score:>1'), 1);
});

const suggest = async (cookie: string, q: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/tags/suggest?q=${encodeURIComponent(q)}`,
    headers: { cookie }
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { suggestions: { tag: string; files: number }[] })
    .suggestions;
};

test('suggestions rank a prefix match above a mid-word one', async () => {
  const lib = await seedLibrary('tagsearch_suggest', [
    ['female', 'light_skinned_female'],
    ['light_skinned_female'],
    ['light_skinned_female']
  ]);
  // `light_skinned_female` is on more files, so only prefix-first ordering
  // puts the tag the user is actually typing at the top.
  const suggestions = await suggest(lib.cookie, 'fem');
  assert.deepEqual(
    suggestions.map((item) => item.tag),
    ['female', 'light_skinned_female']
  );
  assert.equal(suggestions[0].files, 1);
});

test('suggestions offer the canonical name, not the alias', async () => {
  const lib = await seedLibrary('tagsearch_suggest_alias', [['1girls']]);
  setAliases([['1girls', 'female']]);
  assert.deepEqual(
    (await suggest(lib.cookie, 'girl')).map((item) => item.tag),
    []
  );
  assert.deepEqual(
    (await suggest(lib.cookie, 'fem')).map((item) => item.tag),
    ['female']
  );
});

test('suggestions never cross between users', async () => {
  const mine = await seedLibrary('tagsearch_suggest_mine', [['solo']]);
  const theirs = await seedLibrary('tagsearch_suggest_theirs', [['solo']]);
  const suggestions = await suggest(mine.cookie, 'solo');
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].files, 1, 'counted a file from another library');
  assert.ok(theirs.files.length > 0);
});

test('a typed wildcard is matched literally', async () => {
  const lib = await seedLibrary('tagsearch_suggest_wildcard', [['solo']]);
  assert.deepEqual(await suggest(lib.cookie, '%'), []);
});

// Regression: /tags was not in the auth gate's prefix list, so the route in
// it answered without a session.
test('GET /tags/suggest refuses a request with no session', async () => {
  const res = await app.inject({ method: 'GET', url: '/tags/suggest?q=fem' });
  assert.equal(res.statusCode, 401);
});

test('re-adding a manual tag refreshes the tag it collapses to', async () => {
  const lib = await seedLibrary(
    'tagsearch_manual_recanon',
    [['solo']],
    'MANUAL'
  );
  const fileId = lib.files[0].id;
  setAliases([['solo', 'alone']]);
  assert.equal(await search(lib.cookie, 'alone'), 1);

  sqlite
    .prepare('UPDATE file_tags SET canonical_tag = tag WHERE file_id = ?')
    .run(fileId);
  assert.equal(await search(lib.cookie, 'alone'), 0);

  const readd = await app.inject({
    method: 'POST',
    url: `/files/${fileId}/tags/manual`,
    headers: { cookie: lib.cookie },
    payload: { tag: 'solo', category: 'general' }
  });
  assert.equal(readd.statusCode, 200);
  assert.equal(await search(lib.cookie, 'alone'), 1);
});

test('a manual tag is normalised the way search terms are', async () => {
  const lib = await seedLibrary('tagsearch_manual_normalise', [['other']]);
  const fileId = lib.files[0].id;
  const added = await app.inject({
    method: 'POST',
    url: `/files/${fileId}/tags/manual`,
    headers: { cookie: lib.cookie },
    payload: { tag: 'Blue*Eyes', category: 'general' }
  });
  assert.equal(added.statusCode, 200);
  // Stored as the search term spells it, so it can be found again.
  assert.equal(await search(lib.cookie, 'Blue*Eyes'), 1);
  assert.equal(await search(lib.cookie, 'blueeyes'), 1);
});

test('an alias sent to suppress still removes the stored rows', async () => {
  const lib = await seedLibrary('tagsearch_suppress_alias', [['1girls']]);
  setAliases([['1girls', 'female']]);
  const removed = await app.inject({
    method: 'POST',
    url: `/files/${lib.files[0].id}/tags/suppress`,
    headers: { cookie: lib.cookie },
    payload: { tags: ['1girls'] }
  });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual((removed.json() as { tags: unknown[] }).tags, []);
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

const setCategories = (pairs: [string, string][]) => {
  tagDbRepo.replaceTagCategories(
    pairs.map(([tag, category]) => ({ tag, category }))
  );
};

const categoryOf = (fileId: string, tag: string) =>
  (
    sqlite
      .prepare('SELECT category FROM file_tags WHERE file_id = ? AND tag = ?')
      .get(fileId, tag) as { category: string }
  ).category;

test('the imported map categorises a tag the booru filed as general', async () => {
  setCategories([['bat', 'species']]);
  const lib = await seedLibrary('tagcat_fill', [['bat', 'smiling']]);

  assert.equal(categoryOf(lib.files[0].id, 'bat'), 'species');
  // Nothing is invented for a tag the import never saw.
  assert.equal(categoryOf(lib.files[0].id, 'smiling'), 'general');
});

test('a category the booru did state survives the imported map', async () => {
  setCategories([['bat', 'species']]);
  const lib = await seedLibrary('tagcat_keep', [[]]);
  const fileId = lib.files[0].id;
  await filesRepo.replaceTagsForSource(fileId, 'WD14', [
    { tag: 'bat', category: 'character' }
  ]);

  assert.equal(categoryOf(fileId, 'bat'), 'character');
});

test('re-categorising stored tags leaves a hand-picked category alone', async () => {
  const provider = await seedLibrary('tagcat_recat_wd14', [['bat']]);
  const manual = await seedLibrary('tagcat_recat_manual', [['bat']], 'MANUAL');

  setCategories([['bat', 'species']]);
  tagDbRepo.recategoriseFileTags();

  assert.equal(categoryOf(provider.files[0].id, 'bat'), 'species');
  assert.equal(categoryOf(manual.files[0].id, 'bat'), 'general');
});
