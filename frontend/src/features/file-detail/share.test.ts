import { afterEach, describe, expect, it, vi } from 'vitest';

import { canShareFiles, shareLink } from './share';

import { api } from '@/api';

const withNavigator = (navigatorStub: unknown) =>
  vi.stubGlobal('navigator', navigatorStub);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe('shareLink in the app', () => {
  it("uses the app's own sheet, not the page's", async () => {
    const pageShare = vi.fn(() => Promise.resolve());
    withNavigator({ share: pageShare, clipboard: { writeText: vi.fn() } });
    const native = vi.spyOn(api, 'shareLinkNatively').mockResolvedValueOnce(true);
    await expect(shareLink('https://example.invalid/posts/1', 'Post', true)).resolves.toBe('shared');
    expect(native).toHaveBeenCalledWith('https://example.invalid/posts/1');
    expect(pageShare).not.toHaveBeenCalled();
    native.mockResolvedValueOnce(false);
    await expect(shareLink('https://example.invalid/posts/1', 'Post', true)).resolves.toBe('cancelled');
  });

  it('copies the link when the app cannot show its sheet', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    withNavigator({ clipboard: { writeText } });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(api, 'shareLinkNatively').mockRejectedValueOnce(new Error('No window.'));
    await expect(shareLink('https://example.invalid/posts/1', 'Post', true)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('https://example.invalid/posts/1');
  });
});
