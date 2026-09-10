// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  useSubscriptions: vi.fn(),
  useUpdateSubscriptionTags: vi.fn(),
  useArtistSubscriptionMutation: vi.fn()
}));

vi.mock('@/hooks/settings', () => hooks);

import { SubscriptionsSettings } from './SubscriptionsSettings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
});

it('shows a tag-save error beside the tag form', async () => {
  hooks.useSubscriptions.mockReturnValue({
    data: {
      tags: [],
      artistSources: [
        { siteId: 'fa', siteName: 'FurAffinity', artists: [], error: null }
      ],
      targets: []
    },
    isLoading: false,
    error: null
  });
  hooks.useUpdateSubscriptionTags.mockReturnValue({
    error: new Error('At most 100 tags'),
    isPending: false,
    mutate: vi.fn()
  });
  hooks.useArtistSubscriptionMutation.mockReturnValue({
    error: null,
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn()
  });

  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root?.render(<SubscriptionsSettings />));

  const sections = container.querySelectorAll('section');
  expect(
    Array.from(sections).every(
      (section) => !section.classList.contains('settings-section-flat')
    )
  ).toBe(true);
  expect(sections[0]?.querySelector('label')?.textContent).toBe(
    'One tag per row'
  );
  expect(sections[0]?.textContent).toContain('At most 100 tags');
  expect(sections[1]?.textContent).not.toContain('At most 100 tags');
});
