// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { useReloadWhenSyncEnds } from './useReloadWhenSyncEnds';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('reloads once when a running sync ends, not before and not for an idle status', async () => {
  const reload = vi.fn();
  function Probe({ status }: { status?: string }) {
    useReloadWhenSyncEnds(status, reload);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (status?: string) => act(async () => root.render(<Probe status={status} />));
  await render('idle');
  await render('running');
  expect(reload).not.toHaveBeenCalled();
  await render('done');
  expect(reload).toHaveBeenCalledTimes(1);
  await render('idle');
  expect(reload).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
