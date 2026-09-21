// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { DuplicatesView, type DuplicatesViewProps } from './DuplicatesView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const props = (overrides: Partial<DuplicatesViewProps> = {}): DuplicatesViewProps => ({
  settings: { enabled: false, style: null, preferredProviders: [] },
  settingsLoading: false,
  settingsError: null,
  providers: [{ key: 'E621', label: 'e621', iconUrl: null }],
  editing: true,
  draftStyle: null,
  draftProviders: [],
  preview: null,
  previewPending: false,
  previewError: null,
  confirmPending: false,
  confirmError: null,
  latestRun: null,
  selectStyle: vi.fn(),
  toggleProvider: vi.fn(),
  createPreview: vi.fn(),
  confirmPreview: vi.fn(),
  cancelPreview: vi.fn(),
  beginChange: vi.fn(),
  cancelChange: vi.fn(),
  turnOff: vi.fn(),
  retry: vi.fn(),
  retryPending: false,
  ...overrides
});

const render = (viewProps: DuplicatesViewProps) => {
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(<DuplicatesView {...viewProps} />));
  return container;
};

it('renders the strategies as one exclusive radio group', () => {
  const selectStyle = vi.fn();
  const container = render(props({ selectStyle }));
  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect(radios).toHaveLength(2);
  expect(radios[0]?.name).toBe('duplicate-strategy');
  expect(radios[1]?.name).toBe('duplicate-strategy');
  expect(container.textContent).toContain('Only one option can be active at a time');
  expect(container.textContent).toContain('OR');
  act(() => radios[1]?.click());
  expect(selectStyle).toHaveBeenCalledWith('preferred_only');
});

it('shows the allowlist only for preferred providers and blocks an empty selection', () => {
  const createPreview = vi.fn();
  const container = render(props({
    draftStyle: 'preferred_only',
    createPreview
  }));
  expect(container.textContent).toContain('Sites to keep');
  expect(container.textContent).toContain('Select at least one site.');
  const previewButton = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent === 'Preview changes'
  );
  expect(previewButton?.disabled).toBe(true);
});

it('labels the active and pending options without a redundant selected badge', () => {
  const container = render(props({
    settings: { enabled: true, style: 'favorite_all', preferredProviders: [] },
    draftStyle: 'preferred_only',
    draftProviders: ['E621']
  }));
  expect(container.textContent).toContain('Currently active');
  expect(container.textContent).toContain('Pending change');
  expect(container.textContent).not.toContain('Selected');
});

it('keeps individual action details out of the summary', () => {
  const container = render(props({
    editing: false,
    settings: { enabled: true, style: 'favorite_all', preferredProviders: [] },
    latestRun: {
      id: 'run-1',
      kind: 'apply',
      status: 'completed',
      style: 'favorite_all',
      preferredProviders: [],
      reason: 'settings-confirmed',
      totalGroups: 1,
      processedGroups: 1,
      counts: { added: 1, removed: 0, reused: 0, deleted: 0, needsAttention: 0 },
      error: null,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:01.000Z',
      completedAt: '2026-09-19T00:00:01.000Z',
      actions: [{
        id: 'action-1',
        groupKey: 'group-1',
        kind: 'add_favorite',
        status: 'completed',
        provider: 'E621',
        remoteId: '123',
        fileId: null,
        fileName: null,
        message: 'Internal action detail'
      }]
    }
  }));

  expect(container.textContent).toContain('Favorites added');
  expect(container.textContent).not.toContain('Internal action detail');
  expect(Array.from(container.querySelectorAll('button')).some(
    (button) => button.textContent === 'View last actions'
  )).toBe(false);
});

it('places the running status between the summary and progress label', () => {
  const container = render(props({
    editing: false,
    settings: { enabled: true, style: 'favorite_all', preferredProviders: [] },
    latestRun: {
      id: 'run-1',
      kind: 'apply',
      status: 'running',
      style: 'favorite_all',
      preferredProviders: [],
      reason: 'settings-confirmed',
      totalGroups: 10,
      processedGroups: 2,
      counts: { added: 0, removed: 0, reused: 0, deleted: 0, needsAttention: 0 },
      error: null,
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:01.000Z',
      completedAt: null,
      actions: []
    }
  }));

  const text = container.textContent ?? '';
  expect(text.indexOf('matching image sets found')).toBeLessThan(text.indexOf('Running'));
  expect(text.indexOf('Running')).toBeLessThan(text.indexOf('Checking matching images'));
});
