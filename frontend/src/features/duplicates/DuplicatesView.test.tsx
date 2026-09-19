// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { DuplicatesView } from './DuplicatesView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it('shows balanced scan controls before preferred sources', () => {
  const loadDuplicates = vi.fn();
  const container = document.createElement('div');
  root = createRoot(container);
  act(() =>
    root?.render(
      <DuplicatesView
        duplicateSettings={{ autoResolve: false, providerPriority: [] }}
        duplicateProviders={[]}
        duplicateSettingsState={{ loading: false, error: null }}
        updateDuplicateSettings={vi.fn()}
        duplicateState={{ loading: false, error: null }}
        duplicateScanStatus={null}
        loadDuplicates={loadDuplicates}
        duplicatePairs={[]}
        duplicateStats={null}
        duplicateAction={{ loadingId: null, error: null }}
        resolveDuplicateChoice={vi.fn()}
        resolveDuplicateKeepBoth={vi.fn()}
      />
    )
  );

  const sections = container.querySelectorAll('section');
  expect(sections).toHaveLength(2);
  expect(sections[0]?.getAttribute('aria-label')).toBe('Duplicate scan');
  expect(sections[0]?.textContent).toContain(
    'Find visually matching images and videos'
  );
  expect(sections[0]?.textContent).not.toContain(
    'Run a scan to check for duplicates.'
  );
  expect(sections[0]?.textContent).toContain('Auto-resolve after scan');
  expect(sections[1]?.textContent).toContain('Preferred sources');
  expect(sections[1]?.textContent).toContain(
    'Ranks synced favorites before comparing quality.'
  );
  expect(container.querySelector('select, details')).toBeNull();

  const scanButton = sections[0]?.querySelector('button');
  expect(scanButton?.textContent).toBe('Run scan');
  act(() => scanButton?.click());
  expect(loadDuplicates).toHaveBeenCalledOnce();
});
