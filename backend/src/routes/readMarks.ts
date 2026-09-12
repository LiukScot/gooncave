import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { readMarksRepo } from '../db/repos/readMarksRepo';

const scopeSchema = z.enum(['file', 'post']);

// A file key is a uuid and a post key is "<siteId>:<remoteId>", so nothing
// legitimate comes close. Without a length cap the row count is capped but the
// table's size is not, and marks are never pruned.
const MAX_KEY_LENGTH = 256;
// One scroll burst marks a few dozen items; the cap keeps a single request
// from binding an unbounded number of parameters. The client batches to the
// same number — see MAX_BATCH in the frontend read-marks queue.
const MAX_KEYS_PER_REQUEST = 500;

const markSchema = z.object({
  scope: scopeSchema,
  keys: z
    .array(z.string().min(1).max(MAX_KEY_LENGTH))
    .min(1)
    .max(MAX_KEYS_PER_REQUEST)
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
