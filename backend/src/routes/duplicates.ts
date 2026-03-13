import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { dataStore } from '../lib/dataStore';

const scanSchema = z.object({
  mediaType: z.enum(['IMAGE', 'VIDEO', 'ALL']).optional(),
  pixelThreshold: z.number().min(0).max(1).optional(),
  sampleSize: z.number().int().min(8).max(256).optional(),
  videoFrames: z.number().int().min(1).max(8).optional(),
  maxComparisons: z.number().int().min(1).max(100000).optional()
});

export const registerDuplicateRoutes = (app: FastifyInstance) => {
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
