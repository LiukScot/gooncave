import { describe, expect, it } from 'vitest';

import { buildTagGroups } from './sections';

import type { FileTag } from '@/api';

const tag = (overrides: Partial<FileTag> & { tag: string }): FileTag => ({
  canonicalTag: overrides.tag,
  category: 'general',
  source: 'WD14',
  score: null,
  sourceUrl: null,
  ...overrides
});

const pills = (groups: ReturnType<typeof buildTagGroups>) =>
  groups.flatMap((group) =>
    group.tags.map((entry) => ({
      tag: entry.tag,
      originals: entry.originals,
      category: group.category
    }))
  );

describe('buildTagGroups', () => {
  it('merges aliased tags into one pill carrying both originals', () => {
    const groups = buildTagGroups([
      tag({ tag: '1girls', canonicalTag: 'female' }),
      tag({ tag: 'female', canonicalTag: 'female' })
    ]);
    expect(pills(groups)).toEqual([
      { tag: 'female', originals: ['1girls', 'female'], category: 'general' }
    ]);
  });

  it('merges across categories rather than splitting the group', () => {
    // Two providers can file alias-equivalent tags differently. Splitting
    // would render two pills both reading `female`, and removing either
    // would take away only half the group.
    const groups = buildTagGroups([
      tag({ tag: '1girls', canonicalTag: 'female', category: 'general' }),
      tag({ tag: 'female', canonicalTag: 'female', category: 'species' })
    ]);
    const merged = pills(groups);
    expect(merged).toHaveLength(1);
    expect(merged[0].originals).toEqual(['1girls', 'female']);
    // The row spelling the canonical tag decides which section it lands in.
    expect(merged[0].category).toBe('species');
  });

  it('falls back to the first category by name when no row is canonical', () => {
    const groups = buildTagGroups([
      tag({ tag: 'zebra', canonicalTag: 'equine', category: 'species' }),
      tag({ tag: 'aardvark', canonicalTag: 'equine', category: 'artist' })
    ]);
    expect(pills(groups)[0].category).toBe('artist');
  });

  it('does not depend on the order the rows arrive in', () => {
    const rows = [
      tag({ tag: 'zebra', canonicalTag: 'equine', category: 'species' }),
      tag({ tag: 'aardvark', canonicalTag: 'equine', category: 'artist' })
    ];
    expect(pills(buildTagGroups(rows))).toEqual(
      pills(buildTagGroups([...rows].reverse()))
    );
  });

  it('keeps unrelated tags apart', () => {
    const groups = buildTagGroups([
      tag({ tag: 'solo' }),
      tag({ tag: 'female' })
    ]);
    expect(pills(groups).map((pill) => pill.tag)).toEqual(['female', 'solo']);
  });

  it('takes the highest score across the merged rows', () => {
    const groups = buildTagGroups([
      tag({ tag: '1girls', canonicalTag: 'female', score: 0.4 }),
      tag({ tag: 'female', canonicalTag: 'female', score: 0.9 })
    ]);
    expect(groups[0].tags[0].score).toBe(0.9);
  });
});
