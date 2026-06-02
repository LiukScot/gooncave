import { describe, expect, it } from 'vitest';

import { resolveSourceLabel, resolveTopMatchSourceName } from './sourceLabels';

describe('resolveSourceLabel', () => {
  it('maps UUID source to configured site name', () => {
    const siteId = 'ac642e46-fec5-442d-880d-f2216deb8c03';
    expect(resolveSourceLabel(siteId, { [siteId]: 'rule34.xxx' })).toBe(
      'rule34.xxx'
    );
  });

  it('falls back to the raw source value when site is missing', () => {
    const siteId = 'ac642e46-fec5-442d-880d-f2216deb8c03';
    expect(resolveSourceLabel(siteId, {})).toBe(siteId);
  });
});

describe('resolveTopMatchSourceName', () => {
  it('prefers mapped site name when sourceKey points to custom booru site', () => {
    const siteId = 'ac642e46-fec5-442d-880d-f2216deb8c03';
    const label = resolveTopMatchSourceName(
      {
        sourceKey: siteId,
        sourceName: siteId,
        provider: 'SAUCENAO'
      },
      { [siteId]: 'rule34.xxx' }
    );
    expect(label).toBe('rule34.xxx');
  });

  it('keeps preset source names unchanged', () => {
    const label = resolveTopMatchSourceName(
      {
        sourceKey: 'danbooru',
        sourceName: 'danbooru',
        provider: 'SAUCENAO'
      },
      {}
    );
    expect(label).toBe('danbooru');
  });
});
