import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import type {
  DuplicateScanOptions,
  DuplicateScanProgress,
  DuplicateScanResult
} from '../lib/duplicates';
import { siteKey } from '../lib/siteKey';

const scanSchema = z.object({
  mediaType: z.enum(['IMAGE', 'VIDEO', 'ALL']).optional(),
  pixelThreshold: z.number().min(0).max(1).optional(),
  sampleSize: z.number().int().min(8).max(256).optional(),
  videoFrames: z.number().int().min(1).max(8).optional(),
  maxComparisons: z.number().int().min(1).max(100000).optional()
});

const duplicateScanRateLimit = {
  max: 3,
  timeWindow: '1 minute',
  keyGenerator: (request: { headers: Record<string, unknown>; ip: string }) => {
    const intent =
      request.headers['x-duplicate-scan-intent'] === 'automatic'
        ? 'automatic'
        : 'manual';
    return `${request.ip}:${intent}`;
  }
};

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

  const updateScanState = (
    userId: string,
    patch: Partial<DuplicateScanState>
  ) => {
    const current = getScanState(userId);
    scanStates.set(userId, {
      ...current,
      ...patch,
      updatedAt: nowIso()
    });
  };

  const startScan = async (userId: string, options: DuplicateScanOptions) => {
    const existingScan = scanPromises.get(userId);
    if (existingScan) {
      const state = getScanState(userId);
      if (state.status === 'running') {
        app.log.info({
          event: 'duplicate_scan_busy',
          startedAt: state.startedAt,
          progress: state.progress
        });
        return { status: 'busy' as const, state };
      }
      await existingScan;
    }
    const { findDuplicates } = await import('../lib/duplicates.js');
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
    app.log.info({
      event: 'duplicate_scan_started',
      startedAt,
      options
    });

    const promise = (async () => {
      try {
        const result = await findDuplicates(
          userId,
          options,
          (progress: DuplicateScanProgress) => {
            updateScanState(userId, {
              status: 'running',
              progress,
              error: null
            });
          },
          abortController.signal
        );
        if (abortController.signal.aborted) {
          updateScanState(userId, {
            status: 'error',
            error: 'Scan cancelled',
            result: null
          });
        } else {
          updateScanState(userId, { status: 'done', result, error: null });
          app.log.info({
            event: 'duplicate_scan_completed',
            startedAt,
            stats: result.stats
          });
        }
      } catch (err) {
        app.log.error({
          event: 'duplicate_scan_failed',
          startedAt,
          error: (err as Error).message
        });
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

  app.post(
    '/duplicates/scan/start',
    { config: { rateLimit: duplicateScanRateLimit } },
    async (request, reply) => {
      const parsed = scanSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid payload', issues: parsed.error.issues };
      }
      return startScan(request.currentUser!.id, parsed.data);
    }
  );

  app.get('/duplicates/scan/status', async (request) => {
    return getScanState(request.currentUser!.id);
  });

  app.post('/duplicates/scan/cancel', async (request) => {
    const scanAbortController = scanAbortControllers.get(
      request.currentUser!.id
    );
    if (scanAbortController) {
      scanAbortController.abort();
      return { status: 'cancelled' };
    }
    return { status: 'idle' };
  });

  app.get('/duplicates/settings', async (request) => {
    return favoritesRepo.getDuplicateSettings(request.currentUser!.id);
  });

  app.put('/duplicates/settings', async (request, reply) => {
    const parsed = z
      .object({
        enabled: z.literal(false)
      })
      .strict()
      .safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return {
        error: 'Settings can only be disabled directly; preview and confirm other changes',
        issues: parsed.error.issues
      };
    }
    return favoritesRepo.saveDuplicateSettings(
      parsed.data,
      request.currentUser!.id
    );
  });

  const policyInputSchema = z.object({
    style: z.enum(['favorite_all', 'preferred_only']),
    preferredProviders: z.array(z.string().min(1)).default([])
  });

  app.post('/duplicates/policy/preview', async (request, reply) => {
    const parsed = policyInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    if (
      parsed.data.style === 'preferred_only' &&
      parsed.data.preferredProviders.length === 0
    ) {
      reply.code(400);
      return { error: 'Select at least one preferred provider' };
    }
    const available = new Set(
      (await booruSitesRepo.listBooruSites(request.currentUser!.id)).map(siteKey)
    );
    if (
      new Set(parsed.data.preferredProviders).size !== parsed.data.preferredProviders.length ||
      parsed.data.preferredProviders.some(
        (provider) => !available.has(provider)
      )
    ) {
      reply.code(400);
      return { error: 'Preferred providers must be configured sites' };
    }
    const { createDuplicatePolicyPreview } = await import(
      '../services/duplicatePolicy.js'
    );
    return createDuplicatePolicyPreview(request.currentUser!.id, parsed.data);
  });

  app.post('/duplicates/policy/confirm', async (request, reply) => {
    const parsed = z.object({ previewId: z.string().uuid() }).safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    try {
      const { applyDuplicatePolicyPreview } = await import(
        '../services/duplicatePolicy.js'
      );
      return await applyDuplicatePolicyPreview(
        request.currentUser!.id,
        parsed.data.previewId
      );
    } catch (error) {
      reply.code(409);
      return { error: (error as Error).message };
    }
  });

  app.get('/duplicates/policy/status', async (request) => {
    const { getDuplicatePolicyStatus } = await import(
      '../services/duplicatePolicy.js'
    );
    return getDuplicatePolicyStatus(request.currentUser!.id);
  });

  app.post('/duplicates/policy/retry', async (request) => {
    const { queueDuplicatePolicyRun } = await import(
      '../services/duplicatePolicy.js'
    );
    queueDuplicatePolicyRun(request.currentUser!.id, 'manual-retry');
    return { status: 'queued' };
  });
};
