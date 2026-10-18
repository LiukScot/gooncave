import { api, API_BASE, type ExplorePost } from '@/api';

export type ReadScope = 'post';

const SCOPES: ReadScope[] = ['post'];

/** A fast scroll marks dozens of cards a second; they travel as one request. */
const FLUSH_DELAY_MS = 2000;
/**
 * Keys per request. Each key can carry its post for History, and the core
 * refuses a body over 64 KB; a sendBeacon is capped at the same size.
 */
const MAX_BATCH = 25;
/** Posts kept for keys not sent yet; the oldest go first past this. */
const MAX_REMEMBERED_POSTS = 2000;
const PENDING_STORAGE_KEY = 'imagesearch.readMarks.pending.v1';

const pending: Record<ReadScope, Set<string>> = {
  post: new Set()
};

/** The post behind a key, trimmed to what History shows. */
type HistoryPost = Pick<
  ExplorePost,
  | 'remoteId' | 'previewUrl' | 'sampleUrl' | 'fileUrl' | 'width' | 'height'
  | 'score' | 'rating' | 'md5' | 'createdAt' | 'favCount' | 'uploader'
  | 'fileExt' | 'fileSize' | 'parentId' | 'hasChildren' | 'poolIds'
>;
// ponytail: posts queued before a reload lose their copy (keys survive in
// sessionStorage, posts do not); History then lacks the last ~2 seconds.
const remembered = new Map<string, HistoryPost>();

/**
 * Keeps the posts on screen at hand, so a key marked later — by scrolling
 * past a card or opening it — can travel with its post.
 */
export const rememberReadPosts = (posts: readonly ExplorePost[]) => {
  for (const post of posts) {
    const key = `${post.siteId}:${post.remoteId}`;
    remembered.delete(key);
    remembered.set(key, {
      remoteId: post.remoteId,
      previewUrl: post.previewUrl,
      sampleUrl: post.sampleUrl,
      fileUrl: post.fileUrl,
      width: post.width,
      height: post.height,
      score: post.score,
      rating: post.rating,
      md5: post.md5,
      createdAt: post.createdAt,
      favCount: post.favCount,
      uploader: post.uploader,
      fileExt: post.fileExt,
      fileSize: post.fileSize,
      parentId: post.parentId,
      hasChildren: post.hasChildren,
      poolIds: post.poolIds
    });
  }
  for (const key of remembered.keys()) {
    if (remembered.size <= MAX_REMEMBERED_POSTS) break;
    if (!pending.post.has(key)) remembered.delete(key);
  }
};

const postsFor = (keys: string[]): Record<string, HistoryPost> | undefined => {
  const posts = Object.fromEntries(
    keys.flatMap((key) => {
      const post = remembered.get(key);
      return post ? [[key, post]] : [];
    })
  );
  return Object.keys(posts).length ? posts : undefined;
};

const storedPending = (): Partial<Record<ReadScope, string[]>> | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const restored: Partial<Record<ReadScope, string[]>> = {};
    for (const scope of SCOPES) {
      const keys = (value as Record<string, unknown>)[scope];
      if (Array.isArray(keys) && keys.every((key) => typeof key === 'string')) {
        restored[scope] = keys;
      }
    }
    return restored;
  } catch {
    return null;
  }
};

const persistPending = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    const value = Object.fromEntries(
      SCOPES.map((scope) => [scope, [...pending[scope]]])
    );
    if (SCOPES.every((scope) => pending[scope].size === 0)) {
      window.sessionStorage.removeItem(PENDING_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
};

const restored = storedPending();
for (const scope of SCOPES) {
  for (const key of restored?.[scope] ?? []) pending[scope].add(key);
}

/**
 * The send in progress for each scope, so a flush can wait for it. Without
 * this, a refetch can race the debounced write it was meant to follow.
 */
const inFlight: Record<ReadScope, Promise<boolean>> = {
  post: Promise.resolve(true)
};
const beaconed: Record<ReadScope, boolean> = {
  post: false
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

const send = async (scope: ReadScope): Promise<boolean> => {
  const keys = [...pending[scope]];
  if (!keys.length) return true;
  for (const batch of batches(keys)) {
    try {
      await api.markRead(scope, batch, postsFor(batch));
      for (const key of batch) {
        pending[scope].delete(key);
        remembered.delete(key);
      }
      persistPending();
    } catch (err) {
      const retryable = isRetryable(err);
      console.warn(
        `[read-marks] ${scope} batch of ${batch.length} failed` +
          `${retryable ? ', will retry' : ', dropped'}: ${(err as Error).message}`
      );
      // Losing a mark costs one already-seen item coming round again, which is
      // not worth a toast. Retryable keys stay queued for the next flush.
      if (!retryable) {
        for (const key of keys) pending[scope].delete(key);
        persistPending();
      }
      return false;
    }
  }
  return true;
};

/** Queues this scope's send behind whatever is already going out for it. */
const sendScope = (scope: ReadScope): Promise<boolean> => {
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
export const flushReadQueue = async (scope?: ReadScope): Promise<boolean> => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const results = await Promise.all((scope ? [scope] : SCOPES).map(sendScope));
  return results.every(Boolean);
};

/**
 * Hands the queue to the browser to deliver after this document is gone.
 *
 * `fetch` started while the page is going away is cancelled with it, which
 * loses whatever was marked in the last couple of seconds before a reload.
 * sendBeacon hands the request to the browser independently of this document.
 */
const flushOnUnload = () => {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  for (const scope of SCOPES) {
    if (beaconed[scope]) continue;
    const keys = [...pending[scope]];
    if (!keys.length) continue;
    let sent = true;
    for (const batch of batches(keys)) {
      const body = new Blob([JSON.stringify({ scope, keys: batch, posts: postsFor(batch) })], {
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
    // `true` only means queued, not confirmed by the server. Keep the durable
    // copy so a replacement document can send it before fetching unread data.
    if (sent) beaconed[scope] = true;
  }
};

/**
 * Records a loaded page in one storage write. The list on screen is never
 * re-filtered: marks only take effect on the next fetch.
 */
export const queueReads = (scope: ReadScope, keys: readonly string[]) => {
  if (!keys.length) return;
  for (const key of keys) pending[scope].add(key);
  beaconed[scope] = false;
  persistPending();
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    for (const scope of SCOPES) void sendScope(scope);
  }, FLUSH_DELAY_MS);
};

/** Records one card without requiring callers to build an array. */
export const queueRead = (scope: ReadScope, key: string) => {
  queueReads(scope, [key]);
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
