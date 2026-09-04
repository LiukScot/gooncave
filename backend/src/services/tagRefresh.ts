import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import type { BooruSiteRecord } from '../db/types';
import { getEngine } from '../lib/booruEngines';
import { redactUrlSecrets } from '../lib/booruEngines/helpers';

import { applyRemotePostTags } from './tagging';

/**
 * Re-reads the posts a booru site tagged, so tags stored before the engine
 * could see categories get them (issue #311).
 *
 * Reads before it writes, one post at a time, and never removes anything up
 * front: a site that stops answering — rule34 starts serving a CAPTCHA under
 * a steady stream of page fetches — leaves the library exactly as it was
 * rather than empty. `applyRemotePostTags` makes the same call per post and
 * refuses to overwrite categorised tags with a category-less answer, so a
 * run during an outage costs requests and changes nothing.
 */

/** Between posts. A booru will start challenging a faster caller than this. */
const REQUEST_INTERVAL_MS = 1_500;

export type TagRefreshProgress = {
  status: 'idle' | 'running' | 'done' | 'error';
  siteId: string | null;
  processed: number;
  total: number;
  /** Posts that came back with categories and were written. */
  updated: number;
  /** Answered, but with nothing better than what is already stored. */
  unchanged: number;
  failed: number;
  startedAt: string | null;
  updatedAt: string;
  error: string | null;
};

const idle = (): TagRefreshProgress => ({
  status: 'idle',
  siteId: null,
  processed: 0,
  total: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
  startedAt: null,
  updatedAt: new Date().toISOString(),
  error: null
});

const states = new Map<string, TagRefreshProgress>();
const running = new Map<string, Promise<void>>();
const cancelled = new Set<string>();

export const getTagRefreshProgress = (userId: string): TagRefreshProgress =>
  states.get(userId) ?? idle();

export const cancelTagRefresh = (userId: string): boolean => {
  if (!running.has(userId)) return false;
  cancelled.add(userId);
  return true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const patch = (userId: string, next: Partial<TagRefreshProgress>) => {
  states.set(userId, {
    ...getTagRefreshProgress(userId),
    ...next,
    updatedAt: new Date().toISOString()
  });
};

const refreshOne = async (
  site: BooruSiteRecord,
  target: { fileId: string; sourceUrl: string }
): Promise<'updated' | 'unchanged'> => {
  const engine = getEngine(site.engine);
  const extracted = engine?.extractIdFromUrl(target.sourceUrl, site);
  if (!engine || !extracted) return 'unchanged';
  const file = await filesRepo.findFileById(target.fileId);
  if (!file) return 'unchanged';
  const result = await applyRemotePostTags(
    file,
    site.presetKey ?? site.id,
    extracted.remoteId,
    target.sourceUrl
  );
  return result.applied ? 'updated' : 'unchanged';
};

export const startTagRefresh = async (userId: string, siteId: string) => {
  if (running.has(userId)) {
    return { status: 'busy' as const, progress: getTagRefreshProgress(userId) };
  }
  const site = await booruSitesRepo.getBooruSite(siteId, userId);
  if (!site) return { status: 'not-found' as const };

  const targets = await filesRepo.listSourceTagTargets(
    userId,
    site.presetKey ?? site.id,
    { stale: true }
  );
  cancelled.delete(userId);
  patch(userId, {
    status: 'running',
    siteId,
    processed: 0,
    total: targets.length,
    updated: 0,
    unchanged: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    error: null
  });

  const job = (async () => {
    try {
      for (const [index, target] of targets.entries()) {
        if (cancelled.has(userId)) break;
        if (index > 0) await sleep(REQUEST_INTERVAL_MS);
        const current = getTagRefreshProgress(userId);
        try {
          const outcome = await refreshOne(site, target);
          patch(userId, {
            processed: current.processed + 1,
            updated: current.updated + (outcome === 'updated' ? 1 : 0),
            unchanged: current.unchanged + (outcome === 'unchanged' ? 1 : 0)
          });
        } catch (err) {
          // One unreachable post is not a reason to abandon the rest; the
          // message can carry a URL with credentials in it (§10).
          console.warn(
            `[tags] refresh failed for ${target.fileId}: ${redactUrlSecrets((err as Error).message)}`
          );
          patch(userId, {
            processed: current.processed + 1,
            failed: current.failed + 1
          });
        }
      }
      patch(userId, { status: 'done' });
    } catch (err) {
      patch(userId, { status: 'error', error: (err as Error).message });
    } finally {
      running.delete(userId);
      cancelled.delete(userId);
    }
  })();

  running.set(userId, job);
  return { status: 'started' as const, progress: getTagRefreshProgress(userId) };
};
