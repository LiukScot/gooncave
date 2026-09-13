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
  it('scrolls to the top when the active view is selected again', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('window', { scrollTo });
    const event = clickEvent();

    handleViewReselect(event, true);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
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
