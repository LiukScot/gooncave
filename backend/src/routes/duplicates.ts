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
  const scanStates = new Map<string, DuplicateScanState>();
  const scanPromises = new Map<string, Promise<void>>();
  const scanAbortControllers = new Map<string, AbortController>();

  const getScanState = (userId: string): DuplicateScanState => {
    const existing = scanStates.get(userId);
    if (existing) return existing;
    const created: DuplicateScanState = {
      status: 'idle',
      startedAt: null,
      updatedAt: nowIso(),
      progress: null,
      result: null,
      error: null
    };
    scanStates.set(userId, created);
    return created;
  };

  const updateScanState = (userId: string, patch: Partial<DuplicateScanState>) => {
    const current = getScanState(userId);
    scanStates.set(userId, {
      ...current,
      ...patch,
      updatedAt: nowIso()
    });
  };

  const startScan = async (userId: string, options: DuplicateScanOptions) => {
    if (scanPromises.get(userId)) {
      return { status: 'busy' as const, state: getScanState(userId) };
    }
    const { findDuplicates } = await import('../lib/duplicates');
    const startedAt = nowIso();
    const abortController = new AbortController();
    scanAbortControllers.set(userId, abortController);
    updateScanState(userId, {
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

    const promise = (async () => {
      try {
        const result = await findDuplicates(
          userId,
          options,
          (progress) => {
            updateScanState(userId, { status: 'running', progress, error: null });
          },
          abortController.signal
        );
        if (abortController.signal.aborted) {
          updateScanState(userId, { status: 'error', error: 'Scan cancelled', result: null });
        } else {
          updateScanState(userId, { status: 'done', result, error: null });
        }
      } catch (err) {
        updateScanState(userId, {
          status: 'error',
          error: (err as Error).message,
          result: null
        });
      } finally {
        scanPromises.delete(userId);
        scanAbortControllers.delete(userId);
      }
    })();
    scanPromises.set(userId, promise);

    return { status: 'started' as const, state: getScanState(userId) };
  };

  app.post('/duplicates/scan/start', async (request, reply) => {
    const parsed = scanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return startScan(request.currentUser!.id, parsed.data);
  });

  app.get('/duplicates/scan/status', async (request) => {
    return getScanState(request.currentUser!.id);
  });

  app.post('/duplicates/scan/cancel', async (request) => {
    const scanAbortController = scanAbortControllers.get(request.currentUser!.id);
    if (scanAbortController) {
      scanAbortController.abort();
      return { status: 'cancelled' };
    }
    return { status: 'idle' };
  });

  app.post('/duplicates/scan', async (request, reply) => {
    const parsed = scanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const { findDuplicates } = await import('../lib/duplicates');
    const result = await findDuplicates(request.currentUser!.id, parsed.data);
    return result;
  });

  app.get('/duplicates/settings', async (request) => {
    return dataStore.getDuplicateSettings(request.currentUser!.id);
  });

  app.put('/duplicates/settings', async (request, reply) => {
    const parsed = z.object({ autoResolve: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return dataStore.saveDuplicateSettings(parsed.data, request.currentUser!.id);
  });
};
