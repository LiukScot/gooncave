import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { dataStore } from '../lib/dataStore';
import type { DuplicateScanOptions, DuplicateScanProgress, DuplicateScanResult } from '../lib/duplicates';

const scanSchema = z.object({
  mediaType: z.enum(['IMAGE', 'VIDEO', 'ALL']).optional(),
  pixelThreshold: z.number().min(0).max(1).optional(),
  sampleSize: z.number().int().min(8).max(256).optional(),
  videoFrames: z.number().int().min(1).max(8).optional(),
  maxComparisons: z.number().int().min(1).max(100000).optional()
});

export const registerDuplicateRoutes = (app: FastifyInstance) => {
  type DuplicateScanState = {
    status: 'idle' | 'running' | 'done' | 'error';
    startedAt: string | null;
    updatedAt: string;
    progress: DuplicateScanProgress | null;
    result: DuplicateScanResult | null;
    error: string | null;
  };

  const nowIso = () => new Date().toISOString();
  let scanState: DuplicateScanState = {
    status: 'idle',
    startedAt: null,
    updatedAt: nowIso(),
    progress: null,
    result: null,
    error: null
  };
  let scanPromise: Promise<void> | null = null;

  const updateScanState = (patch: Partial<DuplicateScanState>) => {
    scanState = {
      ...scanState,
      ...patch,
      updatedAt: nowIso()
    };
  };

  const startScan = async (options: DuplicateScanOptions) => {
    if (scanPromise) {
      return { status: 'busy' as const, state: scanState };
    }
    const { findDuplicates } = await import('../lib/duplicates');
    const startedAt = nowIso();
    updateScanState({
      status: 'running',
      startedAt,
      progress: {
        phase: 'preparing',
        processed: 0,
        total: 0,
        comparisons: 0,
        groups: 0,
        skippedNoSignature: 0,
        message: 'Preparing duplicate scan'
      },
      result: null,
      error: null
    });

    scanPromise = (async () => {
      try {
        const result = await findDuplicates(options, (progress) => {
          updateScanState({ status: 'running', progress, error: null });
        });
        updateScanState({ status: 'done', result, error: null });
      } catch (err) {
        updateScanState({
          status: 'error',
          error: (err as Error).message,
          result: null
        });
      } finally {
        scanPromise = null;
      }
    })();

    return { status: 'started' as const, state: scanState };
  };

  app.post('/duplicates/scan/start', async (request, reply) => {
    const parsed = scanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return startScan(parsed.data);
  });

  app.get('/duplicates/scan/status', async () => {
    return scanState;
  });

  app.post('/duplicates/scan', async (request, reply) => {
    const parsed = scanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const { findDuplicates } = await import('../lib/duplicates');
    const result = await findDuplicates(parsed.data);
    return result;
  });

  app.get('/duplicates/settings', async () => {
    return dataStore.getDuplicateSettings();
  });

  app.put('/duplicates/settings', async (request, reply) => {
    const parsed = z.object({ autoResolve: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return dataStore.saveDuplicateSettings(parsed.data);
  });
};
