import { afterEach, describe, expect, it, vi } from 'vitest';

import { canShareFiles } from './share';

const withNavigator = (navigatorStub: unknown) =>
  vi.stubGlobal('navigator', navigatorStub);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('canShareFiles', () => {
  it('is false when the browser has no canShare at all', () => {
    withNavigator({ share: () => Promise.resolve() });
    expect(canShareFiles()).toBe(false);
  });

  it('is false when canShare rejects a file payload', () => {
    withNavigator({ canShare: () => false });
    expect(canShareFiles()).toBe(false);
  });

  it('is false when canShare throws on the probe', () => {
    withNavigator({
      canShare: () => {
        throw new TypeError('unsupported payload');
      }
    });
    expect(canShareFiles()).toBe(false);
  });

  it('is true when canShare accepts a file payload', () => {
    withNavigator({
      canShare: (data: { files?: File[] }) => Array.isArray(data.files)
    });
    expect(canShareFiles()).toBe(true);
  });
});
