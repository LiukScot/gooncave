import {
  diagnosticRefusal,
  diagnosticRetry,
  diagnosticWait
} from '../providerDiagnostics';
import { safeFetch } from '../ssrfGuard';

import { abortableSleep, isCloudflareChallenge } from './helpers';

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

/** A 429, or a Cloudflare CAPTCHA page: both lift by themselves. */
const asksForPause = async (res: SiteResponse): Promise<boolean> => {
  if (res.status === 429) {
    diagnosticRefusal(false, true);
    return true;
  }
  if (res.status !== 403 && res.status !== 503) return false;
  const challenge = isCloudflareChallenge(await res.clone().text());
  if (challenge) diagnosticRefusal(true, false);
  return challenge;
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
    if (wait > 0) {
      const finishWait = diagnosticWait(url);
      try {
        await abortableSleep(wait, init.signal);
      } finally {
        finishWait();
      }
    }
    const res = await safeFetch(url, init);
    const paused = await asksForPause(res);
    if (attempt === politeRetry.delaysMs.length || !paused) {
      return res;
    }
    await res.arrayBuffer();
    diagnosticRetry();
    // Another request to this host may already be waiting out a longer pause.
    resumeAtByHost.set(
      host,
      Math.max(
        resumeAtByHost.get(host) ?? 0,
        Date.now() + politeRetry.delaysMs[attempt]
      )
    );
  }
};
