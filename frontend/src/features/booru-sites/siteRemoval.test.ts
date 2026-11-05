import { describe, expect, it, vi } from 'vitest';

import { askSiteRemoval } from './siteRemoval';

describe('askSiteRemoval', () => {
  it('asks only to confirm when nothing is downloaded', async () => {
    const choose = vi.fn().mockResolvedValue('keep');
    expect(await askSiteRemoval(choose, 'Mine', { onlineOnly: 3, downloaded: 0 })).toBe('keep');
    expect(choose.mock.calls[0][1].actions).toHaveLength(1);
    expect(choose.mock.calls[0][0]).toContain('3 posts');
  });

  it('offers to keep or delete downloaded files', async () => {
    const choose = vi.fn().mockResolvedValue('delete');
    expect(await askSiteRemoval(choose, 'Mine', { onlineOnly: 0, downloaded: 2 })).toBe('delete');
    expect(choose.mock.calls[0][1].actions.map((a: { value: string }) => a.value)).toEqual(['keep', 'delete']);
  });

  it('returns null when dismissed', async () => {
    const choose = vi.fn().mockResolvedValue(null);
    expect(await askSiteRemoval(choose, 'Mine', { onlineOnly: 0, downloaded: 0 })).toBeNull();
  });
});
