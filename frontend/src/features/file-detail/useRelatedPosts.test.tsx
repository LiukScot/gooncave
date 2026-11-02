// @vitest-environment happy-dom

import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useRelatedPosts } from './useRelatedPosts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Query results reach the component on a later timer by default, after act() has returned.
notifyManager.setScheduler((notify) => notify());

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('never shows the related posts of the file it just left', async () => {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const id = String(url).match(/files\/([^/]+)\/relations/)?.[1] ?? '';
    asked.push(id);
    return new Response(JSON.stringify({ posts: id === 'with-parent' ? [{ remoteId: 'parent' }] : [] }));
  }));
  const rendered: { fileId: string; posts: string[] }[] = [];
  const Probe = ({ fileId }: { fileId: string }) => {
    const { posts } = useRelatedPosts({ kind: 'file', fileId });
    rendered.push({ fileId, posts: posts.map((post) => post.remoteId) });
    return null;
  };
  const client = new QueryClient();
  root = createRoot(document.createElement('div'));
  const show = (fileId: string) =>
    act(async () => {
      root?.render(<QueryClientProvider client={client}><Probe fileId={fileId} /></QueryClientProvider>);
    });

  await show('with-parent');
  await act(async () => { await vi.waitFor(() => expect(rendered.at(-1)?.posts).toEqual(['parent'])); });
  await show('alone');
  expect(rendered.filter(({ fileId, posts }) => fileId === 'alone' && posts.length > 0)).toEqual([]);

  // Coming back shows them at once, without asking the site again.
  rendered.length = 0;
  await show('with-parent');
  expect(rendered[0].posts).toEqual(['parent']);
  expect(asked.filter((id) => id === 'with-parent')).toHaveLength(1);
});
