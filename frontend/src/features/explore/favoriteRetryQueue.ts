/**
 * Waits between attempts, longer each time; its length is the retry count.
 * About eight minutes in all: a CAPTCHA lifts in seconds, a rate limit can
 * take minutes.
 */
export const FAVORITE_RETRY_DELAYS_MS = [
  3_000, 6_000, 12_000, 25_000, 45_000, 60_000, 90_000, 120_000, 120_000
];

/** Refusals the booru lifts by itself: a CAPTCHA or a 429. */
const RETRYABLE_CODES = new Set(['BOORU_CAPTCHA', 'BOORU_RATE_LIMITED']);

const isRetryable = (error: unknown): boolean =>
  RETRYABLE_CODES.has(String((error as { code?: unknown } | null)?.code));

const wait = (ms: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

/** The last favorite waiting per site; the next one starts when it settles. */
const siteQueues = new Map<string, Promise<void>>();

/**
 * Sends a favorite and, when the booru refuses it for now (a CAPTCHA or a
 * rate limit), sends it again until it goes through.
 *
 * Once a site has refused one favorite, every later favorite for that site
 * lines up behind it and goes in click order, one at a time: sending them in
 * parallel would keep hitting a site that is asking for a pause.
 *
 * @returns the result, or `null` when `stillWanted` turned false while
 * waiting (nothing was added)
 * @throws the refusal once every retry is spent, any other error at once
 */
export const sendWhenSiteAllows = async <T>(
  siteId: string,
  send: () => Promise<T>,
  stillWanted: () => boolean,
  onWaiting: () => void,
  sleep: (ms: number) => Promise<void> = wait
): Promise<T | null> => {
  let refusal: unknown;
  if (!siteQueues.has(siteId)) {
    try {
      return await send();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      refusal = error;
    }
  }
  onWaiting();

  const previous = siteQueues.get(siteId);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = (previous ?? Promise.resolve()).then(() => mine);
  siteQueues.set(siteId, tail);
  try {
    await previous;
    // A post that waited behind another goes at once: the one ahead has
    // usually just got through, so the site is taking favorites again.
    // ponytail: a refusal that outlasts every retry makes each queued post
    // spend its own full budget in turn; share a per-site deadline if that
    // ever shows up.
    const delays = previous
      ? [0, ...FAVORITE_RETRY_DELAYS_MS]
      : FAVORITE_RETRY_DELAYS_MS;
    for (const delay of delays) {
      await sleep(delay);
      if (!stillWanted()) return null;
      try {
        return await send();
      } catch (error) {
        if (!isRetryable(error)) throw error;
        refusal = error;
      }
    }
    throw refusal;
  } finally {
    release();
    if (siteQueues.get(siteId) === tail) siteQueues.delete(siteId);
  }
};
