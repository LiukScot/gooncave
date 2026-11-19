// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEW_POSTS_CHECK_MS, useNewSubscriptionPosts } from './useNewSubscriptionPosts';

import { api } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SITES = ['e621'];
let shown = -1;
function Probe({ newestAt }: { newestAt: number | null }) {
  shown = useNewSubscriptionPosts(newestAt, SITES, true);
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useNewSubscriptionPosts', () => {
  it('counts posts saved above the newest one shown and resets on reload', async () => {
    vi.useFakeTimers();
    const ask = vi.spyOn(api, 'newSubscriptionPosts').mockResolvedValue({ count: 3 });
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe newestAt={1_800_000_000} />));
    expect(shown).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEW_POSTS_CHECK_MS);
    });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ siteIds: SITES, after: 1_800_000_000, unread: true })
    );
    expect(shown).toBe(3);
    // Show new posts reloads the feed, which starts with no newest post.
    await act(async () => root.render(<Probe newestAt={null} />));
    expect(shown).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEW_POSTS_CHECK_MS * 2);
    });
    expect(ask).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('asks at once when the page becomes visible again', async () => {
    const ask = vi.spyOn(api, 'newSubscriptionPosts').mockResolvedValue({ count: 5 });
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe newestAt={1} />));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(shown).toBe(5);
    act(() => root.unmount());
  });
});
