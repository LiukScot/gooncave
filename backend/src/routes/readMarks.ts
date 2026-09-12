import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { readMarksRepo } from '../db/repos/readMarksRepo';

const scopeSchema = z.enum(['file', 'post']);

const markSchema = z.object({
  scope: scopeSchema,
  // One scroll burst marks a few dozen items; the cap keeps a single request
  // from binding an unbounded number of parameters.
  keys: z.array(z.string().min(1)).min(1).max(500)
});

const clearSchema = z.object({
  scope: scopeSchema
});

const readMarkRateLimit = { max: 120, timeWindow: '1 minute' };

export const registerReadMarkRoutes = (app: FastifyInstance) => {
  app.post(
    '/read-marks',
    { config: { rateLimit: readMarkRateLimit } },
    async (request, reply) => {
      const parsed = markSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid body', issues: parsed.error.issues };
      }
      const marked = readMarksRepo.markRead(
        request.currentUser!.id,
        parsed.data.scope,
        parsed.data.keys
      );
      return { marked };
    }
  );

  app.delete(
    '/read-marks',
    { config: { rateLimit: readMarkRateLimit } },
    async (request, reply) => {
      const parsed = clearSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const cleared = readMarksRepo.clearRead(
        request.currentUser!.id,
        parsed.data.scope
      );
      return { cleared };
    }
  );
};
