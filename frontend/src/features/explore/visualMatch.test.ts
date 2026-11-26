import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withVisualMatches } from './visualMatch';

import { api, type ExplorePost } from '@/api';
import { logDeveloper } from '@/lib/windowErrorLog';

vi.mock('@/lib/windowErrorLog', () => ({ logDeveloper: vi.fn() }));

const post = (siteId: string, remoteId: string) =>
  ({ siteId, remoteId, matchPreviewUrl: `/explore/media?u=${remoteId}` } as ExplorePost);

describe('withVisualMatches', () => {
  const copies = vi.spyOn(api, 'exploreCopies');
  beforeEach(() => {
    copies.mockReset();
    vi.mocked(logDeveloper).mockReset();
  });

  it('compares a new page with the posts already in the grid', async () => {
    const shown = [post('e621', '1')];
    const page = [post('rule34', '2'), post('rule34', '3')];
    copies.mockResolvedValue({ copies: [['rule34:2', 'e621:1']] });
    const signal = new AbortController().signal;

    const prepared = await withVisualMatches(page, shown, signal);

    expect(copies).toHaveBeenCalledWith(page, shown, signal);
    expect(prepared).toEqual([{ ...page[0], sameLookAs: ['e621:1'] }, page[1]]);
  });

  it('shows the page and writes to the log when the comparison fails', async () => {
    const page = [post('rule34', '2')];
    copies.mockRejectedValue(new Error('The core did not answer.'));

    expect(await withVisualMatches(page, [], new AbortController().signal)).toEqual(page);
    expect(logDeveloper).toHaveBeenCalledWith(
      'Copies were not looked for among 1 loaded posts: The core did not answer.'
    );
  });
});
