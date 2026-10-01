import { safeFetch } from '../ssrfGuard';

import { isCloudflareChallenge } from './helpers';

type SiteResponse = Awaited<ReturnType<typeof safeFetch>>;

/**
 * Waits between attempts after a site asks for a pause; its length is the
 * retry count. Kept under half a minute in all because the caller's HTTP
 * request stays open meanwhile.
 * ponytail: a refusal that outlasts this still fails the operation; a stored
 * queue of pending remote actions is the upgrade if that keeps happening.
 */
export const politeRetry = { delaysMs: [2_000, 5_000, 12_000] };

/** When each host takes requests again, set by the last refusal. */
const resumeAtByHost = new Map<string, number>();

const sleep = (ms: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(new Error('Request aborted'));
    };
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A 429, or a Cloudflare CAPTCHA page: both lift by themselves. */
const asksForPause = async (res: SiteResponse): Promise<boolean> => {
  if (res.status === 429) return true;
  if (res.status !== 403 && res.status !== 503) return false;
  return isCloudflareChallenge(await res.clone().text());
};

/**
 * `safeFetch` that waits and sends the request again when the site answers
 * with a rate limit or a CAPTCHA.
 *
 * The pause is per host and shared: while one request waits, every other
 * request to that host waits too, because sending them anyway keeps the limit
 * in place. Once the retries are spent the refusal itself is returned, so the
 * caller reports it as before.
 */
export const politeFetch = async (
  url: string,
  init: Parameters<typeof safeFetch>[1] = {}
): Promise<SiteResponse> => {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt += 1) {
    const wait = (resumeAtByHost.get(host) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait, init.signal);
    const res = await safeFetch(url, init);
    if (attempt === politeRetry.delaysMs.length || !(await asksForPause(res))) {
      return res;
    }
    await res.arrayBuffer();
    resumeAtByHost.set(host, Date.now() + politeRetry.delaysMs[attempt]);
  }
};
