import { describe, expect, it, vi } from 'vitest';

import {
  FAVORITE_RETRY_DELAYS_MS,
  sendWhenSiteAllows
} from './favoriteRetryQueue';

const refusal = (code = 'BOORU_CAPTCHA') =>
  Object.assign(new Error('not right now'), { code });
const noSleep = () => Promise.resolve();

describe('sendWhenSiteAllows', () => {
  it('sends again after a CAPTCHA or a rate limit until it goes through', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(refusal('BOORU_CAPTCHA'))
      .mockRejectedValueOnce(refusal('BOORU_RATE_LIMITED'))
      .mockResolvedValue('saved');
    const onWaiting = vi.fn();
    const sleep = vi.fn<(ms: number) => Promise<void>>(noSleep);

    await expect(
      sendWhenSiteAllows('site-a', send, () => true, onWaiting, sleep)
    ).resolves.toBe('saved');
    expect(send).toHaveBeenCalledTimes(3);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
      FAVORITE_RETRY_DELAYS_MS.slice(0, 2)
    );
  });

  it('waits longer before each retry', () => {
    const sorted = [...FAVORITE_RETRY_DELAYS_MS].sort((a, b) => a - b);
    expect(FAVORITE_RETRY_DELAYS_MS).toEqual(sorted);
  });

  it('does not retry any other failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('cookie expired'));
    const onWaiting = vi.fn();

    await expect(
      sendWhenSiteAllows('site-b', send, () => true, onWaiting, noSleep)
    ).rejects.toThrow('cookie expired');
    expect(send).toHaveBeenCalledTimes(1);
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it('gives up with the refusal once every retry is spent', async () => {
    const send = vi.fn().mockRejectedValue(refusal());

    await expect(
      sendWhenSiteAllows('site-c', send, () => true, vi.fn(), noSleep)
    ).rejects.toThrow('not right now');
    expect(send).toHaveBeenCalledTimes(FAVORITE_RETRY_DELAYS_MS.length + 1);
  });

  it('stops without sending when the favorite is no longer wanted', async () => {
    const send = vi.fn().mockRejectedValue(refusal());

    await expect(
      sendWhenSiteAllows('site-d', send, () => false, vi.fn(), noSleep)
    ).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('holds later favorites for a refusing site and sends them in click order', async () => {
    const order: string[] = [];
    let letFirstThrough!: () => void;
    const firstRetry = new Promise<void>((resolve) => {
      letFirstThrough = resolve;
    });
    const first = vi.fn().mockRejectedValueOnce(refusal()).mockImplementation(
      async () => {
        await firstRetry;
        order.push('first');
      }
    );
    const later = (name: string) =>
      vi.fn(async () => {
        order.push(name);
      });
    const second = later('second');
    const third = later('third');

    const a = sendWhenSiteAllows('site-e', first, () => true, vi.fn(), noSleep);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(2));
    const b = sendWhenSiteAllows('site-e', second, () => true, vi.fn(), noSleep);
    const c = sendWhenSiteAllows('site-e', third, () => true, vi.fn(), noSleep);
    // Another site is not held up.
    const other = later('other');
    await sendWhenSiteAllows('site-f', other, () => true, vi.fn(), noSleep);

    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    letFirstThrough();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['other', 'first', 'second', 'third']);
  });
});
