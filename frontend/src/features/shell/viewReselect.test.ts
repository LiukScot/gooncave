import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleViewReselect } from './viewReselect';

const clickEvent = (overrides: Partial<MouseEvent> = {}) =>
  ({
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...overrides
  }) as unknown as MouseEvent;

afterEach(() => vi.unstubAllGlobals());

describe('handleViewReselect', () => {
  it('glides to the top when the active view is selected again', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    );
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('performance', { now: () => 0 });
    const tops: number[] = [];
    vi.stubGlobal('window', {
      scrollY: 1000,
      scrollTo: ({ top }: { top: number }) => tops.push(top),
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    });
    const event = clickEvent();

    handleViewReselect(event, true);
    frames.shift()?.(250);
    frames.shift()?.(500);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    // Part of the way after half the time, more than half by easing, then home.
    expect(tops[0]).toBeGreaterThan(0);
    expect(tops[0]).toBeLessThan(500);
    expect(tops.at(-1)).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('jumps instead of gliding when motion is reduced', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('window', {
      scrollY: 1000,
      scrollTo,
      matchMedia: () => ({ matches: true })
    });

    handleViewReselect(clickEvent(), true);

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it('resets the view before going back to the top', () => {
    const calls: string[] = [];
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('window', { scrollY: 0, scrollTo: () => calls.push('top') });

    handleViewReselect(clickEvent(), true, () => calls.push('reset'));

    expect(calls).toEqual(['reset', 'top']);
  });

  it('does not reset a view it is not on', () => {
    const reset = vi.fn();
    vi.stubGlobal('window', { scrollTo: vi.fn() });

    handleViewReselect(clickEvent(), false, reset);

    expect(reset).not.toHaveBeenCalled();
  });

  it('leaves navigation to a different view alone', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollTo });
    const event = clickEvent();

    handleViewReselect(event, false);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('preserves modified clicks on the active view', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollTo });
    const event = clickEvent({ ctrlKey: true });

    handleViewReselect(event, true);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
