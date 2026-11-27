import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';

import { applyEach, runBulk } from './runBulk';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

describe('runBulk', () => {
  it('reads the changes again after the retry of the failed items too', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    let refuse = true;
    const settled = vi.fn();
    await runBulk('Tagged', [1, 2], async (item) => {
      if (item === 2 && refuse) throw new Error('site refused');
    }, settled);
    expect(settled).toHaveBeenCalledTimes(1);
    const options = vi.mocked(toast.error).mock.calls[0][1] as unknown as { action: { onClick: () => void } };
    refuse = false;
    options.action.onClick();
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledWith('Tagged 1 item');
    quiet.mockRestore();
  });
});
