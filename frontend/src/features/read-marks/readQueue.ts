import { api, API_BASE } from '@/api';

export type ReadScope = 'file' | 'post';

const SCOPES: ReadScope[] = ['file', 'post'];

/** A fast scroll marks dozens of cards a second; they travel as one request. */
const FLUSH_DELAY_MS = 2000;
/** The server rejects a larger batch, so a long burst goes out in slices. */
const MAX_BATCH = 500;

const pending: Record<ReadScope, Set<string>> = {
  file: new Set(),
  post: new Set()
};

let timer: ReturnType<typeof setTimeout> | null = null;

const batches = (keys: string[]): string[][] => {
  const out: string[][] = [];
  for (let start = 0; start < keys.length; start += MAX_BATCH) {
    out.push(keys.slice(start, start + MAX_BATCH));
  }
  return out;
};

const sendScope = async (scope: ReadScope) => {
  const keys = [...pending[scope]];
  if (!keys.length) return;
  pending[scope].clear();
  for (const batch of batches(keys)) {
    try {
      await api.markRead(scope, batch);
    } catch {
      // Losing a mark costs one already-seen item reappearing next time, which
      // is not worth a toast or a retry queue. Put them back so the next flush
      // gets another go while the tab is still open.
      for (const key of batch) pending[scope].add(key);
      return;
    }
  }
};

/**
 * Sends everything queued so far, and resolves once the server has it.
 *
 * Await this before refetching a list that the marks filter: the debounce is
 * long enough that a re-shuffle or a page reset would otherwise be answered
 * from marks the server has not been told about yet, and the reader would see
 * the posts they just scrolled past come round again.
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
 * `fetch` started during pagehide is cancelled with the page, which loses
 * whatever was marked in the last couple of seconds before a reload.
 * sendBeacon is the one request the browser promises to finish.
 */
const flushOnUnload = () => {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  for (const scope of SCOPES) {
    const keys = [...pending[scope]];
    if (!keys.length) continue;
    for (const batch of batches(keys)) {
      const body = new Blob([JSON.stringify({ scope, keys: batch })], {
        type: 'application/json'
      });
      // A refused beacon (queue full) leaves the keys pending rather than
      // pretending they were sent.
      if (!navigator.sendBeacon(`${API_BASE}/read-marks`, body)) return;
    }
    pending[scope].clear();
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
    void Promise.all(SCOPES.map(sendScope));
  }, FLUSH_DELAY_MS);
};

if (typeof window !== 'undefined') {
  // pagehide, not beforeunload: it is the only one mobile Safari fires when
  // the tab is backgrounded into the page cache.
  window.addEventListener('pagehide', flushOnUnload);
}
