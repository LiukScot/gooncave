import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const markRead = vi.fn();

vi.mock('@/api', () => ({
  api: { markRead: (...args: unknown[]) => markRead(...args) },
  API_BASE: '/api'
}));

/** Fresh module state per test: the queue keeps its pending set at module scope. */
const loadQueue = async () => {
  vi.resetModules();
  return import('./readQueue');
};

const httpError = (status: number) => {
  const error = new Error(`HTTP ${status}`) as Error & { status: number };
  error.status = status;
  return error;
};

beforeEach(() => {
  markRead.mockReset();
  markRead.mockResolvedValue({ marked: 1 });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('batches', () => {
  it('splits a long burst into requests the server will accept', async () => {
    const { batches } = await loadQueue();
    expect(batches(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });

  it('leaves a short burst as one request', async () => {
    const { batches } = await loadQueue();
    expect(batches(['a'], 500)).toEqual([['a']]);
  });
});

describe('queueRead', () => {
  it('coalesces a burst into one request per scope', async () => {
    const { queueRead, flushReadQueue } = await loadQueue();
    queueRead('file', 'one');
    queueRead('file', 'two');
    queueRead('post', 'site:1');
    expect(markRead).not.toHaveBeenCalled();

    await flushReadQueue();
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledWith('file', ['one', 'two']);
    expect(markRead).toHaveBeenCalledWith('post', ['site:1']);
  });

  it('sends the same key once', async () => {
    const { queueRead, flushReadQueue } = await loadQueue();
    queueRead('file', 'one');
    queueRead('file', 'one');
    await flushReadQueue();
    expect(markRead).toHaveBeenCalledWith('file', ['one']);
  });

  it('sends on its own after the debounce, without a flush', async () => {
    const { queueRead } = await loadQueue();
    queueRead('file', 'one');
    await vi.advanceTimersByTimeAsync(2000);
    expect(markRead).toHaveBeenCalledWith('file', ['one']);
  });
});

describe('flushReadQueue', () => {
  it('resolves only once a request already in flight has landed', async () => {
    const { queueRead, flushReadQueue } = await loadQueue();
    let settle: (value: unknown) => void = () => {};
    markRead.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      })
    );

    queueRead('file', 'one');
    // The debounce fires and the request opens, emptying the pending set.
    await vi.advanceTimersByTimeAsync(2000);
    expect(markRead).toHaveBeenCalledTimes(1);

    let flushed = false;
    const flush = flushReadQueue().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    settle({ marked: 1 });
    await flush;
    expect(flushed).toBe(true);
  });

  it('does nothing when the queue is empty', async () => {
    const { flushReadQueue } = await loadQueue();
    await flushReadQueue();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('retries a server error on the next flush', async () => {
    const { queueRead, flushReadQueue } = await loadQueue();
    markRead.mockRejectedValueOnce(httpError(503));
    queueRead('file', 'one');
    await flushReadQueue();
    expect(markRead).toHaveBeenCalledTimes(1);

    await flushReadQueue();
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenLastCalledWith('file', ['one']);
  });

  it('drops a rejected batch instead of retrying it forever', async () => {
    const { queueRead, flushReadQueue } = await loadQueue();
    markRead.mockRejectedValueOnce(httpError(400));
    queueRead('file', 'one');
    await flushReadQueue();

    await flushReadQueue();
    expect(markRead).toHaveBeenCalledTimes(1);
  });
});
