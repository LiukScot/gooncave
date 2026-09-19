import path from 'path';

import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import {
  duplicatePolicyRepo,
  type DuplicatePolicyAction,
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

type PlannedAction = Omit<
  DuplicatePolicyAction,
  'id' | 'status' | 'position'
>;

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
    const sourceUrl = action.message.match(/https?:\/\/\S+/)?.[0] ?? '';
    await favoriteMatchedPost(
      userId,
      action.provider,
      action.remoteId,
      sourceUrl,
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

export const applyDuplicatePolicyPreview = async (
  userId: string,
  previewId: string,
  reason = 'settings-confirmation'
) => {
  const preview = duplicatePolicyRepo.getRun(previewId, userId);
  if (!preview || preview.kind !== 'preview' || preview.status !== 'ready') {
    throw new Error('Preview is no longer available');
  }
  if (Date.now() - new Date(preview.createdAt).getTime() > 15 * 60 * 1000) {
    throw new Error('Preview expired; create a new preview');
  }
  const runId = duplicatePolicyRepo.createRun({
    userId,
    kind: 'apply',
    style: preview.style,
    preferredProviders: preview.preferredProviders,
    reason
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
  await favoritesRepo.saveDuplicateSettings(
    {
      enabled: true,
      style: preview.style,
      preferredProviders: preview.preferredProviders
    },
    userId
  );
  void executeDuplicatePolicyRun(userId, runId).catch((error: unknown) => {
    duplicatePolicyRepo.updateRun(runId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unexpected policy error',
      completed_at: new Date().toISOString()
    });
  });
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

const queuedRuns = new Map<string, { timer: NodeJS.Timeout; reasons: Set<string> }>();

export const queueDuplicatePolicyRun = (userId: string, reason: string) => {
  const existing = queuedRuns.get(userId);
  if (existing) {
    existing.reasons.add(reason);
    clearTimeout(existing.timer);
  }
  const reasons = existing?.reasons ?? new Set<string>();
  reasons.add(reason);
  const timer = setTimeout(async () => {
    queuedRuns.delete(userId);
    try {
      const settings = await favoritesRepo.getDuplicateSettings(userId);
      if (!settings.enabled || !settings.style) return;
      if (duplicatePolicyRepo.hasActiveApplyRun(userId)) {
        for (const queuedReason of reasons) {
          queueDuplicatePolicyRun(userId, queuedReason);
        }
        return;
      }
      const preview = await createDuplicatePolicyPreview(userId, {
        style: settings.style,
        preferredProviders: settings.preferredProviders
      });
      if (!preview || preview.status !== 'ready') return;
      await applyDuplicatePolicyPreview(
        userId,
        preview.id,
        `automatic:${Array.from(reasons).sort().join(',')}`
      );
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('UNIQUE constraint failed')) {
        queueDuplicatePolicyRun(userId, 'queued-after-active-run');
      } else {
        console.error('[duplicate-policy] automatic run failed', {
          userId,
          reasons: Array.from(reasons),
          error: message
        });
      }
    }
  }, 1500);
  queuedRuns.set(userId, { timer, reasons });
};

export const recoverDuplicatePolicyRunsOnStartup = () => {
  const users = duplicatePolicyRepo.recoverInterruptedRuns();
  for (const userId of users) {
    queueDuplicatePolicyRun(userId, 'resume-after-restart');
  }
  return users.length;
};
