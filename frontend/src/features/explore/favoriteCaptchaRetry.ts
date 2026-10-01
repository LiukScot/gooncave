/** Waits between attempts; its length is the retry count (about 70s in all). */
export const CAPTCHA_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 20_000, 30_000];

const isCaptchaError = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'BOORU_CAPTCHA';

const wait = (ms: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

/** The last queued retry per site; the next one starts when it settles. */
const siteQueues = new Map<string, Promise<void>>();

/**
 * Sends a favorite and, when the booru answers with a CAPTCHA, sends it again
 * until it goes through.
 *
 * rule34.xxx puts a CAPTCHA in front of favorites for a few seconds at a
 * time. Retries are queued per site, one at a time: several posts retrying
 * in parallel would keep hitting the site while it is asking to slow down.
 *
 * @returns the result, or `null` when `stillWanted` turned false while
 * waiting (nothing was added)
 * @throws the CAPTCHA error once every retry is spent, any other error at once
 */
export const retryOnCaptcha = async <T>(
  siteId: string,
  send: () => Promise<T>,
  stillWanted: () => boolean,
  onWaiting: () => void,
  sleep: (ms: number) => Promise<void> = wait
): Promise<T | null> => {
  let captcha: unknown;
  try {
    return await send();
  } catch (error) {
    if (!isCaptchaError(error)) throw error;
    captcha = error;
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
    // usually just got through, so the CAPTCHA is gone.
    // ponytail: a CAPTCHA that outlasts every retry makes each queued post
    // spend its own full budget in turn; share a per-site deadline if that
    // ever shows up.
    const delays = previous
      ? [0, ...CAPTCHA_RETRY_DELAYS_MS]
      : CAPTCHA_RETRY_DELAYS_MS;
    for (const delay of delays) {
      await sleep(delay);
      if (!stillWanted()) return null;
      try {
        return await send();
      } catch (error) {
        if (!isCaptchaError(error)) throw error;
        captcha = error;
      }
    }
    throw captcha;
  } finally {
    release();
    if (siteQueues.get(siteId) === tail) siteQueues.delete(siteId);
  }
};
