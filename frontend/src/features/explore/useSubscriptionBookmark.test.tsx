// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useSubscriptionBookmark, visibleSubscriptionPost } from './useSubscriptionBookmark';

import { api, type ExplorePost } from '@/api';

vi.mock('./actionToast', () => ({ notifyActionError: vi.fn() }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const post: ExplorePost = {
  remoteId: '7', siteId: 'fixture', siteName: 'Fixture', engine: 'e621',
  previewUrl: 'https://cdn.example.com/7.jpg', sampleUrl: null, fileUrl: null,
  width: 100, height: 100, score: null, rating: null, md5: null, createdAt: null,
  tags: [], favCount: null, uploader: null, fileExt: 'jpg', fileSize: null,
  favorited: false, voted: null, sourceUrl: 'https://example.com/posts/7',
  parentId: null, hasChildren: false, poolIds: []
};
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('bookmarks a visible card rather than one above or below the viewport', () => {
  const posts = [post, { ...post, remoteId: '8' }, { ...post, remoteId: '9' }];
  expect(visibleSubscriptionPost([
    { key: 'fixture:7', top: -300, bottom: -1 },
    { key: 'fixture:8', top: 100, bottom: 300 },
    { key: 'fixture:9', top: 900, bottom: 1100 }
  ], posts, 600)?.remoteId).toBe('8');
  expect(visibleSubscriptionPost([{ key: 'fixture:7', top: 900, bottom: 1100 }], posts, 600)).toBeUndefined();
});

it('serializes reading bookmarks so the last opened post wins', async () => {
  vi.useFakeTimers();
  let finish: (() => void) | undefined;
  const saved = vi.spyOn(api, 'saveSubscriptionBookmark').mockImplementationOnce(() => new Promise((resolve) => {
    finish = () => resolve({ ok: true });
  })).mockResolvedValue({ ok: true });
  const posts = [post, { ...post, remoteId: '8' }];
  function Harness({ selected }: { selected: ExplorePost }) {
    useSubscriptionBookmark(true, posts, selected);
    return null;
  }
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(<Harness selected={post} />);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(saved).toHaveBeenCalledWith({ siteId: 'fixture', remoteId: '7' });
  await act(async () => { root?.render(<Harness selected={posts[1]} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(saved).toHaveBeenCalledTimes(1);
  await act(async () => { finish?.(); });
  expect(saved).toHaveBeenLastCalledWith({ siteId: 'fixture', remoteId: '8' });
});
