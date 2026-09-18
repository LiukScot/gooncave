// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { TagPills } from './DetailSections';
import {
  useFileDetailController,
  type FileDetailControllerOutput
} from './useFileDetailController';

import { ConfirmProvider } from '@/components/confirm-dialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Condition was not met');
};

const buttonLabelled = (label: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent === label
  );

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('subscribes to and blacklists a tag picked from a gallery tag pill', async () => {
  const subscribed: string[] = [];
  let blacklisted: string[] = ['gore'];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/settings/blacklist')) {
      if (init?.method === 'PUT') {
        blacklisted = (JSON.parse(String(init.body)) as { tags: string[] }).tags;
      }
      return Response.json({ tags: blacklisted, applyToExplore: true, applyToGallery: false });
    }
    if (url.endsWith('/settings/subscriptions/tags') && init?.method === 'POST') {
      subscribed.push((JSON.parse(String(init.body)) as { tag: string }).tag);
      return Response.json({ tags: subscribed });
    }
    if (url.endsWith('/settings/subscriptions/tags')) {
      return Response.json({ tags: subscribed });
    }
    return Response.json({ sites: [] });
  });
  vi.stubGlobal('fetch', fetchMock);

  let ctl: FileDetailControllerOutput | null = null;
  function Harness() {
    ctl = useFileDetailController({
      gallery: { files: [], currentIndex: -1, goRelative: () => {} },
      sourceSettings: { display: [], targets: [] },
      mediaFullscreen: false,
      onFullscreenChange: () => {},
      onClose: () => {},
      onFileDeleted: () => {},
      onFileRestored: () => {}
    });
    return (
      <TagPills
        groups={[{
          category: 'general',
          tags: [{
            tag: 'red_fox_(character)',
            originals: ['red_fox_(character)'],
            category: 'general',
            sources: new Set<string>(),
            score: null
          }]
        }]}
        sourceSummary="none"
        onSelectTag={ctl.panelProps.onSelectTag}
      />
    );
  }

  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  act(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <Harness />
        </ConfirmProvider>
      </QueryClientProvider>
    )
  );

  act(() => ctl!.panelProps.onSelectTag('red_fox_(character)'));
  await waitFor(() => Boolean(buttonLabelled('Subscribe')));
  act(() => buttonLabelled('Subscribe')!.click());

  await waitFor(() => subscribed.length > 0);
  expect(subscribed).toEqual(['red_fox_(character)']);

  act(() => ctl!.panelProps.onSelectTag('red_fox_(character)'));
  await waitFor(() => Boolean(buttonLabelled('Add to blacklist')));
  expect(buttonLabelled('Add to blacklist')?.dataset.variant).toBe('destructive');
  expect(document.querySelector('[aria-label="Blacklisted"]')).toBeNull();
  act(() => buttonLabelled('Add to blacklist')!.click());
  await waitFor(() => blacklisted.length > 1);
  expect(blacklisted).toEqual(['gore', 'red_fox_(character)']);
  await waitFor(() => Boolean(document.querySelector('[aria-label="Blacklisted"]')));
});
