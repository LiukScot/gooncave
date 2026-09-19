// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { BooruEngineSupportTable } from './BooruEngineSupportTable';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('@/hooks/booru-sites', () => ({
  useBooruEngineCatalog: () => ({
    data: {
      engines: [
        {
          type: 'furaffinity',
          credentialSchema: 'username+session-cookie',
          defaultCapabilities: {
            favorites: true,
            tags: true,
            sourceMatch: true,
            search: true,
            vote: false
          },
          supportedExploreSorts: ['new'],
          supportsExploreTagSearch: false,
          supportsSessionCookie: true,
          supportsRelations: false,
          supportsPools: false
        }
      ],
      presets: []
    },
    isLoading: false,
    error: null
  })
}));

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it('shows distinct Explore and post-structure capabilities', () => {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(<BooruEngineSupportTable />));

  const headings = Array.from(container.querySelectorAll('th')).map((cell) =>
    cell.textContent?.trim()
  );
  expect(headings).toEqual([
    'Source',
    'Favorites',
    'Tags',
    'Source match',
    'New',
    'Hot',
    'Popular',
    'Tag search',
    'Vote',
    'Relations',
    'Pools'
  ]);

  const support = Array.from(container.querySelectorAll('tbody td')).map(
    (cell) => cell.textContent?.trim()
  );
  expect(support).toEqual([
    'FurAffinity',
    '✓available',
    '✓available',
    '✓available',
    '✓available',
    '✗not available',
    '✗not available',
    '✗not available',
    '✗not available',
    '✗not available',
    '✗not available'
  ]);
});
