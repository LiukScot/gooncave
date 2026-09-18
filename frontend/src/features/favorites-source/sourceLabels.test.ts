import { describe, expect, it } from 'vitest';

import { mapSourcesWithSiteNames } from './sourceLabels';

import type { BooruSite, SourceEntry } from '@/api';

describe('mapSourcesWithSiteNames', () => {
  it('uses site name for custom UUID source keys', () => {
    const siteId = 'ac642e46-fec5-442d-880d-f2216deb8c03';
    const sources: SourceEntry[] = [{ key: siteId, label: siteId, count: 4 }];
    const booruSites: BooruSite[] = [
      {
        id: siteId,
        name: 'rule34.xxx',
        engine: 'gelbooru',
        baseUrl: 'https://rule34.xxx',
        username: null,
        hasApiKey: false,
        hasSessionCookie: false,
        engineSupportsSessionCookie: false,
        isPreset: false,
        presetKey: null,
        enabled: true,
        siteAutoSyncMidnight: false,
        siteReverseSyncEnabled: false,
        siteAutoFavEnabled: false,
        sortOrder: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        engineCredentialSchema: 'none'
      }
    ];

    const mapped = mapSourcesWithSiteNames(sources, booruSites);
    expect(mapped[0]?.label).toBe('rule34.xxx');
  });

  it('falls back to original label when the custom site no longer exists', () => {
    const siteId = 'ac642e46-fec5-442d-880d-f2216deb8c03';
    const sources: SourceEntry[] = [{ key: siteId, label: siteId, count: 4 }];

    const mapped = mapSourcesWithSiteNames(sources, []);
    expect(mapped[0]?.label).toBe(siteId);
  });

  it('keeps preset providers unchanged', () => {
    const sources: SourceEntry[] = [
      { key: 'danbooru', label: 'danbooru', count: 9 }
    ];

    const mapped = mapSourcesWithSiteNames(sources, []);
    expect(mapped[0]?.label).toBe('danbooru');
  });
});
