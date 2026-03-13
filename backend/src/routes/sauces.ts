import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { dataStore, FileRecord, ProviderRunRecord } from '../lib/dataStore';
import { collectSaucesFromRuns, hasTargetSauce, normalizeSauceKey } from '../lib/sauces';

const settingsSchema = z.object({
  display: z.array(z.string()).optional(),
  targets: z.array(z.string()).optional(),
  displayInitialized: z.boolean().optional()
});

const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

type SauceProgressSummary = {
  total: number;
  matched: number;
  failed: number;
  pending: number;
  videos: number;
  failedImages: number;
};

const getRunTimeMs = (run: Pick<ProviderRunRecord, 'createdAt' | 'completedAt'>) => {
  const raw = run.completedAt ?? run.createdAt;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};

const buildSauceProgress = (
  files: Array<Pick<FileRecord, 'id' | 'mediaType'>>,
  providerRunsByFile: Record<string, ProviderRunRecord[]>,
  targetKeys: Set<string>
): SauceProgressSummary => {
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
    if (hasTargetSauce(runs, targetKeys)) {
      matched += 1;
      continue;
    }

    if (!runs.length) {
      pending += 1;
      continue;
    }

    const hasActiveRun = runs.some((run) => run.status === 'PENDING' || run.status === 'RUNNING');
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
    failedImages
  };
};

export const registerSauceRoutes = (app: FastifyInstance) => {
  app.get('/sauces', async () => {
    const [{ files, providerRunsByFile }, settings] = await Promise.all([
      dataStore.listFilesWithProviderRuns(),
      dataStore.getSauceSettings()
    ]);
    const runs = Object.values(providerRunsByFile).flat();
    const sources = collectSaucesFromRuns(runs);
    const targetKeys = new Set((settings.targets ?? []).map(normalizeSauceKey));
    const progress = buildSauceProgress(files, providerRunsByFile, targetKeys);
    return { sources, settings, progress };
  });

  app.put('/sauces/settings', async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid settings payload', issues: parsed.error.issues };
    }
    const settings = await dataStore.saveSauceSettings(parsed.data);
    const { files, providerRunsByFile } = await dataStore.listFilesWithProviderRuns();
    const targetKeys = new Set((settings.targets ?? []).map(normalizeSauceKey));
    const progress = buildSauceProgress(files, providerRunsByFile, targetKeys);
    return { settings, progress };
  });
};
