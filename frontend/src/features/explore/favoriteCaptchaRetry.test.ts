import { describe, expect, it, vi } from 'vitest';

import {
  CAPTCHA_RETRY_DELAYS_MS,
  retryOnCaptcha
} from './favoriteCaptchaRetry';

const captcha = () =>
  Object.assign(new Error('asked for a CAPTCHA'), { code: 'BOORU_CAPTCHA' });
const noSleep = () => Promise.resolve();

describe('retryOnCaptcha', () => {
  it('sends again after a CAPTCHA until the favorite goes through', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(captcha())
      .mockRejectedValueOnce(captcha())
      .mockResolvedValue('saved');
    const onWaiting = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>(noSleep);

    await expect(
      retryOnCaptcha('site-a', send, () => true, onWaiting, sleep)
    ).resolves.toBe('saved');
    expect(send).toHaveBeenCalledTimes(3);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
      CAPTCHA_RETRY_DELAYS_MS.slice(0, 2)
    );
  });

  it('does not retry any other failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('cookie expired'));
    const onWaiting = vi.fn();

    await expect(
      retryOnCaptcha('site-b', send, () => true, onWaiting, noSleep)
    ).rejects.toThrow('cookie expired');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('gives up with the CAPTCHA error once every retry is spent', async () => {
    const send = vi.fn().mockRejectedValue(captcha());

    await expect(
      retryOnCaptcha('site-c', send, () => true, vi.fn(), noSleep)
    ).rejects.toThrow('asked for a CAPTCHA');
    expect(send).toHaveBeenCalledTimes(CAPTCHA_RETRY_DELAYS_MS.length + 1);
  });

  it('stops without sending when the favorite is no longer wanted', async () => {
    const send = vi.fn().mockRejectedValue(captcha());

    await expect(
      retryOnCaptcha('site-d', send, () => false, vi.fn(), noSleep)
    ).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries one post at a time per site', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstRetry = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = vi.fn().mockRejectedValueOnce(captcha()).mockImplementation(
      async () => {
        await firstRetry;
        order.push('first');
      }
    );
    const second = vi.fn().mockRejectedValueOnce(captcha()).mockImplementation(
      async () => {
        order.push('second');
      }
    );

    const a = retryOnCaptcha('site-e', first, () => true, vi.fn(), noSleep);
    const b = retryOnCaptcha('site-e', second, () => true, vi.fn(), noSleep);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2));
    expect(second).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([a, b]);
    expect(order).toEqual(['first', 'second']);
  });
});
