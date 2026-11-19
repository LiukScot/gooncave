// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_CHECK_MS,
  useSubscriptionProgress,
  type SubscriptionProgress
} from './useSubscriptionProgress';

import { api } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let shown: SubscriptionProgress | null | undefined;
function Probe({ active }: { active: boolean }) {
  shown = useSubscriptionProgress(active);
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useSubscriptionProgress', () => {
  it('follows the running sync while the feed waits, and stops asking once it shows', async () => {
    vi.useFakeTimers();
    const ask = vi
      .spyOn(api, 'subscriptionProgress')
      .mockResolvedValueOnce({ read: null, total: null })
      .mockResolvedValue({ read: 40, total: 359 });
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe active />));
    expect(shown).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRESS_CHECK_MS);
    });
    expect(shown).toEqual({ read: 40, total: 359 });
    await act(async () => root.render(<Probe active={false} />));
    expect(shown).toBeNull();
    const asked = ask.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRESS_CHECK_MS * 4);
    });
    expect(ask).toHaveBeenCalledTimes(asked);
    act(() => root.unmount());
  });
});
