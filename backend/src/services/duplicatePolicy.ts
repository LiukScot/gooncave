import path from 'path';

import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import {
  duplicatePolicyRepo,
  type DuplicatePolicyAction,
  type DuplicatePolicyRequest,
  type DuplicatePolicyStyle
} from '../db/repos/duplicatePolicyRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import type { FavoriteItemRecord } from '../db/types';
import {
  findDuplicates,
  type DuplicateFileSummary,
  type DuplicateGroup
} from '../lib/duplicates';
import { extractFavoriteRemoteFromSiteList } from '../lib/favoriteSourceMatch';
import { providerMatchThreshold } from '../lib/providerThresholds';
import { siteKey } from '../lib/siteKey';

import { deleteFileRecord } from './duplicateResolver';
import { favoriteMatchedPost, unfavoriteMatchedPost } from './favorites';

type PolicyInput = {
  style: DuplicatePolicyStyle;
  preferredProviders: string[];
};

/** The request cannot be served as things stand; the route answers 409. */
export class DuplicatePolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicatePolicyConflictError';
  }
}

/** Another apply run of the same user is still in progress. */
export class DuplicatePolicyBusyError extends DuplicatePolicyConflictError {
  constructor() {
    super('A duplicate policy run is already in progress');
    this.name = 'DuplicatePolicyBusyError';
  }
}

type PlannedAction = Omit<
  DuplicatePolicyAction,
  'id' | 'status' | 'position'
>;

/** How long a preview stays confirmable; the library may drift after that. */
const PREVIEW_TTL_MS = 15 * 60 * 1000;

const compareQuality = (a: DuplicateFileSummary, b: DuplicateFileSummary) => {
  const areaA = (a.width ?? 0) * (a.height ?? 0);
  const areaB = (b.width ?? 0) * (b.height ?? 0);
  if (areaA !== areaB) return areaB - areaA;
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.path.localeCompare(b.path);
};

const remoteKey = (provider: string, remoteId: string) =>
  `${provider}\u0000${remoteId}`;

const discoverMatches = (
  group: DuplicateGroup,
  sites: Awaited<ReturnType<typeof booruSitesRepo.listBooruSites>>,
  existing: FavoriteItemRecord[]
) => {
  const matches = new Map<
    string,
    { provider: string; remoteId: string; sourceUrl: string; existing: boolean }
  >();
  for (const item of existing) {
    matches.set(remoteKey(item.provider, item.remoteId), {
      provider: item.provider,
      remoteId: item.remoteId,
      sourceUrl: item.sourceUrl ?? '',
      existing: true
    });
  }
  for (const file of group.files) {
    for (const run of Object.values(file.providers)) {
      if (!run || run.status !== 'COMPLETED') continue;
      const candidates = run.results?.length
        ? run.results
        : [{ sourceUrl: run.sourceUrl, score: run.score }];
      const threshold = providerMatchThreshold(run.provider);
      for (const candidate of candidates) {
        if (
          typeof candidate.score !== 'number' ||
          !Number.isFinite(candidate.score) ||
          candidate.score < threshold
        ) continue;
        const remote = extractFavoriteRemoteFromSiteList(
          candidate.sourceUrl,
          sites
        );
        if (!remote) continue;
        const provider = siteKey(remote.site);
        const key = remoteKey(provider, remote.remoteId);
        if (!matches.has(key)) {
          matches.set(key, {
            provider,
            remoteId: remote.remoteId,
            sourceUrl: candidate.sourceUrl ?? '',
            existing: false
          });
        }
      }
    }
  }
  return Array.from(matches.values());
};

const planGroup = async (
  userId: string,
  group: DuplicateGroup,
  input: PolicyInput,
  sites: Awaited<ReturnType<typeof booruSitesRepo.listBooruSites>>
): Promise<PlannedAction[]> => {
  const files = [...group.files].sort(compareQuality);
  const canonical = files[0];
  const existing = await favoritesRepo.listFavoriteItemsByPaths(
    files.map((file) => file.path),
    userId
  );
  const matches = discoverMatches(group, sites, existing);
  const desired = matches.filter(
    (match) =>
      input.style === 'favorite_all' ||
      input.preferredProviders.includes(match.provider)
  );
  const actions: PlannedAction[] = [];

  if (input.style === 'preferred_only' && desired.length === 0) {
    actions.push({
      groupKey: group.key,
      kind: 'attention',
      provider: null,
      remoteId: null,
      fileId: canonical.id,
      fileName: path.basename(canonical.path),
      message: 'No matching favorite was found on an allowed provider; this group will stay unchanged.'
    });
    return actions;
  }

  actions.push({
    groupKey: group.key,
    kind: 'reuse_file',
    provider: null,
    remoteId: null,
    fileId: canonical.id,
    fileName: path.basename(canonical.path),
    message: `Use ${path.basename(canonical.path)} as the shared local file.`
  });

  const existingKeys = new Set(
    existing.map((item) => remoteKey(item.provider, item.remoteId))
  );
  const removesExistingFavorite =
    input.style === 'preferred_only' &&
    existing.some(
      (item) => !input.preferredProviders.includes(item.provider)
    );
  for (const match of desired) {
    const exists = existingKeys.has(remoteKey(match.provider, match.remoteId));
    if (exists && !removesExistingFavorite) continue;
    actions.push({
      groupKey: group.key,
      kind: exists ? 'confirm_favorite' : 'add_favorite',
      provider: match.provider,
      remoteId: match.remoteId,
      fileId: canonical.id,
      fileName: path.basename(canonical.path),
      message: exists
        ? `Confirm ${match.provider} post ${match.remoteId} is favorited.`
        : `Add ${match.provider} post ${match.remoteId} to favorites.`
    });
  }

  for (const item of existing) {
    const keep =
      input.style === 'favorite_all' ||
      input.preferredProviders.includes(item.provider);
    if (keep && item.filePath !== canonical.path) {
      actions.push({
        groupKey: group.key,
        kind: 'reuse_file',
        provider: item.provider,
        remoteId: item.remoteId,
        fileId: canonical.id,
        fileName: path.basename(canonical.path),
        message: `Reuse ${path.basename(canonical.path)} for ${item.provider} post ${item.remoteId}.`
      });
    }
  }

  if (input.style === 'preferred_only') {
    for (const item of existing) {
      if (input.preferredProviders.includes(item.provider)) continue;
      actions.push({
        groupKey: group.key,
        kind: 'remove_favorite',
        provider: item.provider,
        remoteId: item.remoteId,
        fileId: null,
        fileName: null,
        message: `Remove ${item.provider} post ${item.remoteId} from favorites.`
      });
    }
  }

  for (const file of files.slice(1)) {
    actions.push({
      groupKey: group.key,
      kind: 'delete_file',
      provider: null,
      remoteId: null,
      fileId: file.id,
      fileName: path.basename(file.path),
      message: `Delete redundant local file ${path.basename(file.path)}.`
    });
  }
  return actions;
};

const countActions = (actions: PlannedAction[]) => ({
  added: actions.filter((action) => action.kind === 'add_favorite').length,
  removed: actions.filter((action) => action.kind === 'remove_favorite').length,
  reused: actions.filter((action) => action.kind === 'reuse_file').length,
  deleted: actions.filter((action) => action.kind === 'delete_file').length,
  needs_attention: actions.filter((action) => action.kind === 'attention').length
});

export const createDuplicatePolicyPreview = async (
  userId: string,
  input: PolicyInput
) => {
  const runId = duplicatePolicyRepo.createRun({
    userId,
    kind: 'preview',
    ...input,
    reason: 'settings-preview'
  });
  try {
    const [result, sites] = await Promise.all([
      findDuplicates(userId, {
        mediaType: 'ALL',
        maxComparisons: Number.MAX_SAFE_INTEGER
      }),
      booruSitesRepo.listBooruSites(userId)
    ]);
    const actions: PlannedAction[] = [];
    for (const group of result.groups) {
      actions.push(...(await planGroup(userId, group, input, sites)));
    }
    duplicatePolicyRepo.addActions(runId, actions);
    duplicatePolicyRepo.updateRun(runId, {
      status: 'ready',
      total_groups: result.groups.length,
      ...countActions(actions)
    });
  } catch (error) {
    duplicatePolicyRepo.updateRun(runId, {
      status: 'failed',
      error: (error as Error).message,
      completed_at: new Date().toISOString()
    });
  }
  return duplicatePolicyRepo.getRun(runId, userId);
};

const applyAction = async (
  userId: string,
  action: DuplicatePolicyAction,
  canonicalPath: string | null
) => {
  if (
    action.kind === 'add_favorite' ||
    action.kind === 'confirm_favorite'
  ) {
    if (!action.provider || !action.remoteId || !canonicalPath) {
      throw new Error('Favorite action is missing its target');
    }
    // The planned action keeps no source URL; favoriteMatchedPost builds
    // the post URL from the site when given an empty one.
    await favoriteMatchedPost(
      userId,
      action.provider,
      action.remoteId,
      '',
      canonicalPath
    );
  } else if (action.kind === 'reuse_file') {
    if (!action.provider && !action.remoteId) return;
    if (!action.provider || !action.remoteId || !canonicalPath) {
      throw new Error('Reuse action is missing its target');
    }
    await favoritesRepo.repointFavoriteItem(
      action.provider,
      action.remoteId,
      canonicalPath,
      userId
    );
  } else if (action.kind === 'remove_favorite') {
    if (!action.provider || !action.remoteId) {
      throw new Error('Unfavorite action is missing its target');
    }
    await unfavoriteMatchedPost(userId, action.provider, action.remoteId);
  } else if (action.kind === 'delete_file') {
    if (!action.fileId) throw new Error('Delete action is missing its file');
    const deleted = await deleteFileRecord(action.fileId, userId);
    if (!deleted) throw new Error('File is still referenced or could not be deleted');
  }
};

const loadConfirmablePreview = (userId: string, previewId: string) => {
  const preview = duplicatePolicyRepo.getRun(previewId, userId);
  if (!preview || preview.kind !== 'preview' || preview.status !== 'ready') {
    throw new DuplicatePolicyConflictError('Preview is no longer available');
  }
  if (Date.now() - new Date(preview.createdAt).getTime() > PREVIEW_TTL_MS) {
    throw new DuplicatePolicyConflictError('Preview expired; create a new preview');
  }
  if (duplicatePolicyRepo.hasActiveApplyRun(userId)) {
    throw new DuplicatePolicyBusyError();
  }
  return preview;
};

/**
 * Makes the previewed policy the user's setting and asks the worker to apply
 * the preview. The API never executes a run itself: only the worker does, so
 * a restart of either process cannot leave two of them working the same
 * library (see `processDuplicatePolicyRequests`).
 */
export const confirmDuplicatePolicyPreview = async (
  userId: string,
  previewId: string
) => {
  const preview = loadConfirmablePreview(userId, previewId);
  await favoritesRepo.saveDuplicateSettings(
    {
      enabled: true,
      style: preview.style,
      preferredProviders: preview.preferredProviders
    },
    userId
  );
  duplicatePolicyRepo.requestRun(userId, 'settings-confirmation', preview.id);
  return { status: 'queued' as const };
};

/** Worker only: records the apply run and executes it to the end. */
export const applyDuplicatePolicyPreview = async (
  userId: string,
  previewId: string,
  reason: string
) => {
  const preview = loadConfirmablePreview(userId, previewId);
  let runId: string;
  try {
    runId = duplicatePolicyRepo.createRun({
      userId,
      kind: 'apply',
      style: preview.style,
      preferredProviders: preview.preferredProviders,
      reason
    });
  } catch (error) {
    // The check above and this insert are not atomic; the partial unique
    // index on running apply runs is what actually decides.
    if ((error as Error).message.includes('UNIQUE constraint failed')) {
      throw new DuplicatePolicyBusyError();
    }
    throw error;
  }
  // A preview is applied once: a request renewed mid-run, or a second
  // confirm of the same id, must plan afresh instead of replaying stale actions.
  duplicatePolicyRepo.updateRun(preview.id, {
    status: 'completed',
    completed_at: new Date().toISOString()
  });
  duplicatePolicyRepo.addActions(
    runId,
    preview.actions.map((action) => ({
      groupKey: action.groupKey,
      kind: action.kind,
      provider: action.provider,
      remoteId: action.remoteId,
      fileId: action.fileId,
      fileName: action.fileName,
      message: action.message
    }))
  );
  duplicatePolicyRepo.updateRun(runId, {
    status: 'running',
    total_groups: preview.totalGroups,
    needs_attention: preview.counts.needsAttention
  });
  try {
    await executeDuplicatePolicyRun(userId, runId);
  } catch (error) {
    duplicatePolicyRepo.updateRun(runId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unexpected policy error',
      completed_at: new Date().toISOString()
    });
  }
  return duplicatePolicyRepo.getRun(runId, userId);
};

const executeDuplicatePolicyRun = async (userId: string, runId: string) => {
  const run = duplicatePolicyRepo.getRun(runId, userId);
  if (!run) return;
  let processedGroups = 0;
  let failures = 0;
  const completedCounts = { added: 0, removed: 0, reused: 0, deleted: 0 };
  const grouped = new Map<string, DuplicatePolicyAction[]>();
  for (const action of run.actions) {
    const bucket = grouped.get(action.groupKey) ?? [];
    bucket.push(action);
    grouped.set(action.groupKey, bucket);
  }
  for (const actions of grouped.values()) {
    const attention = actions.some((action) => action.kind === 'attention');
    if (attention) {
      for (const action of actions) duplicatePolicyRepo.updateAction(action.id, 'skipped');
      processedGroups += 1;
      continue;
    }
    const canonicalAction = actions.find(
      (action) => action.kind === 'reuse_file' && !action.provider
    );
    let canonicalPath: string | null = null;
    if (canonicalAction?.fileId) {
      const { filesRepo } = await import('../db/repos/filesRepo.js');
      canonicalPath = (await filesRepo.findFileById(canonicalAction.fileId, userId))?.path ?? null;
    }
    let groupFailed = false;
    for (const action of actions) {
      if (action.kind === 'attention') continue;
      if (groupFailed && (action.kind === 'remove_favorite' || action.kind === 'delete_file')) {
        duplicatePolicyRepo.updateAction(action.id, 'skipped', `${action.message} Skipped after an earlier failure.`);
        continue;
      }
      try {
        await applyAction(userId, action, canonicalPath);
        duplicatePolicyRepo.updateAction(action.id, 'completed');
        if (action.kind === 'add_favorite') completedCounts.added += 1;
        if (action.kind === 'remove_favorite') completedCounts.removed += 1;
        if (action.kind === 'reuse_file') completedCounts.reused += 1;
        if (action.kind === 'delete_file') completedCounts.deleted += 1;
      } catch (error) {
        failures += 1;
        groupFailed = true;
        duplicatePolicyRepo.updateAction(
          action.id,
          'failed',
          `${action.message} ${(error as Error).message}`
        );
      }
    }
    processedGroups += 1;
    duplicatePolicyRepo.updateRun(runId, {
      processed_groups: processedGroups,
      ...completedCounts
    });
  }
  duplicatePolicyRepo.updateRun(runId, {
    status: failures > 0 ? 'partial' : 'completed',
    processed_groups: processedGroups,
    ...completedCounts,
    error: failures > 0 ? `${failures} actions could not be completed` : null,
    completed_at: new Date().toISOString()
  });
};

export const getDuplicatePolicyStatus = (userId: string) => ({
  latestRun: duplicatePolicyRepo.getLatestRun(userId, 'apply')
});

/** How often the worker looks for requests. Also the debounce of a burst. */
export const DUPLICATE_POLICY_POLL_MS = 2_000;

/**
 * Asks the worker for a run of the user's policy. Callable from any process;
 * requests of the same user made before the worker gets to them merge.
 */
export const queueDuplicatePolicyRun = (userId: string, reason: string) => {
  duplicatePolicyRepo.requestRun(userId, reason);
};

const runRequest = async (request: DuplicatePolicyRequest) => {
  const reason = request.reasons.join(',');
  if (request.previewId) {
    try {
      await applyDuplicatePolicyPreview(request.userId, request.previewId, reason);
      return;
    } catch (error) {
      if (
        error instanceof DuplicatePolicyBusyError ||
        !(error instanceof DuplicatePolicyConflictError)
      ) {
        throw error;
      }
      // The confirmed preview expired while waiting. The policy it enabled is
      // saved, so a fresh plan below gives the same result.
    }
  }
  const settings = await favoritesRepo.getDuplicateSettings(request.userId);
  if (!settings.enabled || !settings.style) return;
  const preview = await createDuplicatePolicyPreview(request.userId, {
    style: settings.style,
    preferredProviders: settings.preferredProviders
  });
  if (!preview || preview.status !== 'ready') return;
  await applyDuplicatePolicyPreview(
    request.userId,
    preview.id,
    `automatic:${reason}`
  );
};

let processing: Promise<void> | null = null;

/**
 * One pass over the waiting requests, worker only. A request renewed while
 * its run was in progress keeps its row and is served on the next pass; one
 * whose user still has a run in progress waits as well.
 */
export const processDuplicatePolicyRequests = (): Promise<void> => {
  processing ??= (async () => {
    for (const request of duplicatePolicyRepo.listRequests()) {
      if (duplicatePolicyRepo.hasActiveApplyRun(request.userId)) continue;
      try {
        await runRequest(request);
      } catch (error) {
        if (error instanceof DuplicatePolicyBusyError) continue;
        console.error('[duplicate-policy] run failed', {
          userId: request.userId,
          reasons: request.reasons,
          error: (error as Error).message
        });
      }
      duplicatePolicyRepo.deleteRequest(request.userId, request.requestedAt);
    }
  })().finally(() => {
    processing = null;
  });
  return processing;
};

export const recoverDuplicatePolicyRunsOnStartup = () => {
  const users = duplicatePolicyRepo.recoverInterruptedRuns();
  for (const userId of users) {
    queueDuplicatePolicyRun(userId, 'resume-after-restart');
  }
  return users.length;
};
