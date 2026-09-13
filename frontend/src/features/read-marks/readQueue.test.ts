import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const markRead = vi.fn();

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
};

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
  vi.unstubAllGlobals();
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
  it('recovers a queued mark after a reload before fetching unread posts', async () => {
    const sessionStorage = memoryStorage();
    vi.stubGlobal('window', {
      sessionStorage,
      addEventListener: vi.fn()
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible'
    });
    const beforeReload = await loadQueue();
    beforeReload.queueRead('post', 'site:one');

    const afterReload = await loadQueue();
    await afterReload.flushReadQueue();

    expect(markRead).toHaveBeenCalledWith('post', ['site:one']);

    markRead.mockClear();
    const afterConfirmation = await loadQueue();
    await afterConfirmation.flushReadQueue();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('keeps a beaconed mark recoverable until the server confirms it', async () => {
    const sessionStorage = memoryStorage();
    let onVisibilityChange = () => {};
    vi.stubGlobal('window', {
      sessionStorage,
      addEventListener: vi.fn()
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn((name: string, listener: () => void) => {
        if (name === 'visibilitychange') onVisibilityChange = listener;
      }),
      visibilityState: 'hidden'
    });
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) });
    const beforeReload = await loadQueue();
    beforeReload.queueRead('post', 'site:one');
    onVisibilityChange();

    const afterReload = await loadQueue();
    await afterReload.flushReadQueue();

    expect(markRead).toHaveBeenCalledWith('post', ['site:one']);
  });

  it('still sends when session storage is unavailable', async () => {
    vi.stubGlobal('window', {
      get sessionStorage() {
        throw new Error('SecurityError');
      },
      addEventListener: vi.fn()
    });
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      visibilityState: 'visible'
    });
    const { queueRead, flushReadQueue } = await loadQueue();

    queueRead('post', 'site:one');
    await flushReadQueue();

    expect(markRead).toHaveBeenCalledWith('post', ['site:one']);
  });

  it('resolves only once a request already in flight has landed', async () => {
    const { queueRead, flushReadQueue } = await loadQueue();
    let settle: (value: unknown) => void = () => {};
    markRead.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      })
    );

    queueRead('file', 'one');
    // The debounce fires and opens the request.
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
