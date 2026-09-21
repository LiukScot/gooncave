// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useExtraSettings } from './settings';

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
      readTracking: settings.galleryUnreadOnlyEnabled
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
      galleryUnreadOnlyEnabled: false,
      exploreStackDuplicates: false
    }), { status: 200 }));
  });
  await waitFor(() => states.at(-1)?.loaded === true);
  expect(states.at(-1)).toEqual({ loaded: true, readTracking: false });
});
