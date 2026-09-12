import { api, API_BASE } from '@/api';

export type ReadScope = 'file' | 'post';

const SCOPES: ReadScope[] = ['file', 'post'];

/** A fast scroll marks dozens of cards a second; they travel as one request. */
const FLUSH_DELAY_MS = 2000;
/**
 * Keys per request. The server rejects a larger batch, so this has to stay at
 * or below the cap in routes/readMarks.ts — a mismatch would turn every flush
 * into a 400.
 */
const MAX_BATCH = 500;

const pending: Record<ReadScope, Set<string>> = {
  file: new Set(),
  post: new Set()
};

/**
 * The send in progress for each scope, so a flush can wait for it. Without
 * this, a flush arriving while the debounced request is open finds `pending`
 * already emptied and resolves at once, and the refetch it was meant to
 * order behind races the write.
 */
const inFlight: Record<ReadScope, Promise<void>> = {
  file: Promise.resolve(),
  post: Promise.resolve()
};

let timer: ReturnType<typeof setTimeout> | null = null;

export const batches = (keys: string[], size = MAX_BATCH): string[][] => {
  const out: string[][] = [];
  for (let start = 0; start < keys.length; start += size) {
    out.push(keys.slice(start, start + size));
  }
  return out;
};

/**
 * A rejected batch is worth retrying only if the server might answer
 * differently next time. A 4xx is the client being wrong — a key too long, a
 * batch over the cap, a dead session — and requeuing it would retry forever
 * while the queue grows on every scroll.
 */
const isRetryable = (error: unknown): boolean => {
  const status = (error as { status?: number } | undefined)?.status;
  return status === undefined || status >= 500;
};

const send = async (scope: ReadScope) => {
  const keys = [...pending[scope]];
  if (!keys.length) return;
  pending[scope].clear();
  for (const batch of batches(keys)) {
    try {
      await api.markRead(scope, batch);
    } catch (err) {
      const retryable = isRetryable(err);
      console.warn(
        `[read-marks] ${scope} batch of ${batch.length} failed` +
          `${retryable ? ', will retry' : ', dropped'}: ${(err as Error).message}`
      );
      // Losing a mark costs one already-seen item coming round again, which is
      // not worth a toast. Retryable ones go back so the next flush has a go.
      if (retryable) for (const key of batch) pending[scope].add(key);
      return;
    }
  }
};

/** Queues this scope's send behind whatever is already going out for it. */
const sendScope = (scope: ReadScope): Promise<void> => {
  const next = inFlight[scope].then(() => send(scope));
  inFlight[scope] = next;
  return next;
};

/**
 * Sends everything queued so far, and resolves once the server has it —
 * including a request that was already in flight.
 *
 * Await this before refetching a list that the marks filter: the debounce is
 * long enough that a re-shuffle or a page reset would otherwise be answered
 * from marks the server has not been told about yet, and the reader would see
 * the items they just scrolled past come round again.
 */
export const flushReadQueue = async (): Promise<void> => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  await Promise.all(SCOPES.map(sendScope));
};

/**
 * Hands the queue to the browser to deliver after this document is gone.
 *
 * `fetch` started while the page is going away is cancelled with it, which
 * loses whatever was marked in the last couple of seconds before a reload.
 * sendBeacon is the one request the browser promises to finish.
 */
const flushOnUnload = () => {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  for (const scope of SCOPES) {
    const keys = [...pending[scope]];
    if (!keys.length) continue;
    let sent = true;
    for (const batch of batches(keys)) {
      const body = new Blob([JSON.stringify({ scope, keys: batch })], {
        type: 'application/json'
      });
      // A refused beacon (the browser's queue is full) leaves this scope's
      // keys pending rather than pretending they were sent. The other scope
      // still gets its turn.
      if (!navigator.sendBeacon(`${API_BASE}/read-marks`, body)) {
        sent = false;
        break;
      }
    }
    if (sent) pending[scope].clear();
  }
};

/**
 * Records that the user has been shown this item. The list on screen is never
 * re-filtered: the mark only takes effect on the next fetch.
 */
export const queueRead = (scope: ReadScope, key: string) => {
  pending[scope].add(key);
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    for (const scope of SCOPES) void sendScope(scope);
  }, FLUSH_DELAY_MS);
};

if (typeof window !== 'undefined') {
  // visibilitychange first, pagehide second. iOS Safari can discard a tab
  // without ever firing pagehide — reloading after a scroll there lost the
  // marks entirely — while "hidden" is reached on every path out of the page:
  // reload, tab switch, and the app going to the background. Both listeners
  // stay, because a desktop reload from a visible tab only fires pagehide.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushOnUnload();
  });
  window.addEventListener('pagehide', flushOnUnload);
}
