// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useArtistSubscriptionMutation, useExtraSettings, useUpdateBlacklistSettings, useUpdateSubscriptionTags } from './settings';

import { api } from '@/api';
import { readExploreSnapshot, writeExploreSnapshot } from '@/features/explore/exploreSnapshot';
import { queryKeys } from '@/lib/query-keys';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Condition was not met');
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('reopens subscriptions with fresh results after changing a search or artist', async () => {
  let resolveTags: ((result: { tags: string[] }) => void) | undefined;
  vi.spyOn(api, 'updateSubscriptionTags').mockImplementation(() => new Promise((resolve) => { resolveTags = resolve; }));
  vi.spyOn(api, 'subscribeArtist').mockResolvedValue({ ok: true });
  let changeSearch: (() => Promise<unknown>) | undefined;
  let followArtist: (() => Promise<unknown>) | undefined;
  function Probe() {
    const searches = useUpdateSubscriptionTags();
    const follow = useArtistSubscriptionMutation(true);
    changeSearch = () => searches.mutateAsync(['new_search']);
    followArtist = () => follow.mutateAsync({ siteId: 'fixture', artist: 'fixture-artist' });
    return null;
  }
  root = createRoot(document.createElement('div'));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.settings.subscriptionTags(), { tags: ['old_search'] });
  await act(async () => { root?.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
  const saveResults = () => writeExploreSnapshot({
    key: 'subscribed-feed', posts: [], siteErrors: [], hasMore: true,
    streams: new Map(), subscriptionCursor: 'old-cursor', seen: { keys: new Set() }, scrollY: 600
  });
  saveResults();
  let changed: Promise<unknown> | undefined;
  await act(async () => { changed = changeSearch?.(); });
  expect(queryClient.getQueryData(queryKeys.settings.subscriptionTags())).toEqual({ tags: ['old_search'] });
  await act(async () => { resolveTags?.({ tags: ['new_search'] }); await changed; });
  expect(readExploreSnapshot('subscribed-feed')).toBeNull();
  saveResults();
  await act(async () => { await followArtist?.(); });
  expect(readExploreSnapshot('subscribed-feed')).toBeNull();
});

it('reopens Explore with fresh results after the blacklist changes', async () => {
  vi.spyOn(api, 'updateBlacklist').mockResolvedValue({ tags: ['hidden'], applyToExplore: true } as never);
  let save: (() => Promise<unknown>) | undefined;
  function Probe() {
    const update = useUpdateBlacklistSettings();
    save = () => update.mutateAsync({ tags: ['hidden'] });
    return null;
  }
  root = createRoot(document.createElement('div'));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root?.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
  writeExploreSnapshot({
    key: 'search', posts: [], siteErrors: [], hasMore: true,
    streams: new Map(), subscriptionCursor: null, seen: { keys: new Set() }, scrollY: 0
  });
  await act(async () => { await save?.(); });
  expect(readExploreSnapshot('search')).toBeNull();
});

it('distinguishes loading defaults from persisted extra settings', async () => {
  let resolveSettings!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
    resolveSettings = resolve;
  })));
  const states: Array<{ loaded: boolean; readTracking: boolean }> = [];
  const Probe = () => {
    const settings = useExtraSettings();
    states.push({
      loaded: settings.loaded,
      readTracking: settings.readTrackingEnabled
    });
    return null;
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  root = createRoot(document.createElement('div'));

  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>
    );
  });
  expect(states.at(-1)).toEqual({ loaded: false, readTracking: true });

  await act(async () => {
    resolveSettings(new Response(JSON.stringify({
      gamesTabEnabled: true,
      voteSystemEnabled: false,
      autoVoteOnFavorite: true,
      readTrackingEnabled: false,
      exploreStackDuplicates: false
    }), { status: 200 }));
  });
  await waitFor(() => states.at(-1)?.loaded === true);
  expect(states.at(-1)).toEqual({ loaded: true, readTracking: false });
});
