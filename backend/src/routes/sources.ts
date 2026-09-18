import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { favoritesRepo } from '../db/repos/favoritesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import type { FileRecord, ProviderRunRecord } from '../db/types';
import { DAY_MS } from '../lib/providerRunner';
import {
  collectSourcesFromRuns,
  hasTargetSource,
  normalizeSourceKey
} from '../lib/sources';

const settingsSchema = z.object({
  display: z.array(z.string()).optional(),
  targets: z.array(z.string()).optional(),
  displayInitialized: z.boolean().optional()
});

const sevenDaysMs = 7 * DAY_MS;

type SourceProgressSummary = {
  total: number;
  matched: number;
  failed: number;
  pending: number;
  videos: number;
  failedImages: number;
  failedVideos: number;
};

const getRunTimeMs = (
  run: Pick<ProviderRunRecord, 'createdAt' | 'completedAt'>
) => {
  const raw = run.completedAt ?? run.createdAt;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};

const buildSourceProgress = (
  files: Array<Pick<FileRecord, 'id' | 'mediaType'>>,
  providerRunsByFile: Record<string, ProviderRunRecord[]>,
  targetKeys: Set<string>
): SourceProgressSummary => {
  let matched = 0;
  let pending = 0;
  let videos = 0;
  let failedImages = 0;
  let failedVideos = 0;
  const nowMs = Date.now();

  for (const file of files) {
    if (file.mediaType === 'VIDEO') {
      videos += 1;
    }

    const runs = providerRunsByFile[file.id] ?? [];
    if (hasTargetSource(runs, targetKeys)) {
      matched += 1;
      continue;
    }

    if (!runs.length) {
      pending += 1;
      continue;
    }

    const hasActiveRun = runs.some(
      (run) => run.status === 'PENDING' || run.status === 'RUNNING'
    );
    if (hasActiveRun) {
      pending += 1;
      continue;
    }

    let firstRunMs: number | null = null;
    for (const run of runs) {
      const runMs = getRunTimeMs(run);
      if (runMs === null) continue;
      if (firstRunMs === null || runMs < firstRunMs) {
        firstRunMs = runMs;
      }
    }

    if (firstRunMs === null) {
      pending += 1;
      continue;
    }

    if (nowMs - firstRunMs > sevenDaysMs) {
      if (file.mediaType === 'IMAGE') {
        failedImages += 1;
      } else {
        failedVideos += 1;
      }
    } else {
      pending += 1;
    }
  }

  const failed = failedImages + failedVideos;
  return {
    total: matched + failed + pending,
    matched,
    failed,
    pending,
    videos,
    failedImages,
    failedVideos
  };
};

export const registerSourceRoutes = (app: FastifyInstance) => {
  app.get('/sources', async (request) => {
    const userId = request.currentUser!.id;
    const [{ files, providerRunsByFile }, settings] = await Promise.all([
      filesRepo.listFilesWithProviderRuns(undefined, userId),
      favoritesRepo.getSourceSettings(userId)
    ]);
    const runs = Object.values(providerRunsByFile).flat();
    const sources = collectSourcesFromRuns(runs);
    const targetKeys = new Set((settings.targets ?? []).map(normalizeSourceKey));
    const progress = buildSourceProgress(files, providerRunsByFile, targetKeys);
    return { sources, settings, progress };
  });

  app.put('/sources/settings', async (request, reply) => {
    const userId = request.currentUser!.id;
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid settings payload', issues: parsed.error.issues };
    }
    const settings = await favoritesRepo.saveSourceSettings(parsed.data, userId);
    const { files, providerRunsByFile } =
      await filesRepo.listFilesWithProviderRuns(undefined, userId);
    const targetKeys = new Set((settings.targets ?? []).map(normalizeSourceKey));
    const progress = buildSourceProgress(files, providerRunsByFile, targetKeys);
    return { settings, progress };
  });
};
