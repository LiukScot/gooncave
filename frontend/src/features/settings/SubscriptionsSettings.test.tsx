// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { SubscriptionsSettings } from './SubscriptionsSettings';

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

it('shows a tag-save error beside the tag form', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify({ error: 'Invalid tag list' }), {
        status: 400,
        statusText: 'Bad Request'
      });
    }
    return new Response(
      JSON.stringify({
        tags: [],
        artistSources: [
          { siteId: 'fa', siteName: 'FurAffinity', artists: [], error: null }
        ],
        targets: []
      }),
      { status: 200 }
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <SubscriptionsSettings />
      </QueryClientProvider>
    );
  });
  await waitFor(() => container.textContent?.includes('FurAffinity') ?? false);

  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('Tag textarea was not rendered');
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    setValue?.call(textarea, 'red_fox');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const save = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Save tags'
  );
  if (!save) throw new Error('Save tags button was not rendered');
  await act(async () => save.click());
  await waitFor(() => container.textContent?.includes('Invalid tag list') ?? false);

  const sections = container.querySelectorAll('section');
  expect(sections[0]?.querySelector('label')?.textContent).toBe(
    'One tag per row'
  );
  expect(sections[0]?.textContent).toContain('Invalid tag list');
  expect(sections[1]?.textContent).not.toContain('Invalid tag list');
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/settings/subscriptions/tags',
    expect.objectContaining({ method: 'PUT' })
  );
});
