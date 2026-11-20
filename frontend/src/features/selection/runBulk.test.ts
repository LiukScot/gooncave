import { describe, expect, it } from 'vitest';

import { applyEach } from './runBulk';

describe('applyEach', () => {
  it('keeps going after a failure and says which items failed', async () => {
    const order: number[] = [];
    const result = await applyEach([1, 2, 3], async (item) => {
      order.push(item);
      if (item === 2) throw new Error('site refused');
    });
    expect(order).toEqual([1, 2, 3]);
    expect(result.done).toEqual([1, 3]);
    expect(result.failed.map(({ item }) => item)).toEqual([2]);
  });

  it('runs one item at a time', async () => {
    let running = 0;
    let most = 0;
    await applyEach([1, 2, 3], async () => {
      running += 1;
      most = Math.max(most, running);
      await Promise.resolve();
      running -= 1;
    });
    expect(most).toBe(1);
  });
});
