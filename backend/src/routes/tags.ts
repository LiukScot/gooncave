import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { tagDbRepo } from '../db/repos/tagDbRepo';
import { normalizeTag } from '../lib/booruEngines/helpers';
import {
  dropCustomAlias,
  importTagDatabase,
  setCustomAlias,
  tagDatabaseStatus
} from '../services/tagDb';

const aliasSchema = z.object({
  antecedent: z.string().min(1),
  consequent: z.string().min(1)
});

// The import pulls ~5 MB and rewrites both tables. One a minute is far more
// than the weekly job needs and stops a stuck button from hammering e621.
const importRateLimit = { max: 1, timeWindow: '1 minute' };

export const registerTagRoutes = (app: FastifyInstance) => {
  app.get('/tags/database', async () => tagDatabaseStatus());

  app.post(
    '/tags/database/refresh',
    { config: { rateLimit: importRateLimit } },
    async (_request, reply) => {
      try {
        const result = await importTagDatabase();
        return { status: 'ok', ...result, ...tagDatabaseStatus() };
      } catch (err) {
        reply.code(502);
        return { error: (err as Error).message };
      }
    }
  );

  app.get('/tags/aliases', async () => ({
    aliases: tagDbRepo.listCustomAliases()
  }));

  app.post('/tags/aliases', async (request, reply) => {
    const parsed = aliasSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const antecedent = normalizeTag(parsed.data.antecedent);
    const consequent = normalizeTag(parsed.data.consequent);
    if (!antecedent || !consequent) {
      reply.code(400);
      return { error: 'Both tags are required' };
    }
    if (antecedent === consequent) {
      reply.code(400);
      return { error: 'A tag cannot be an alias of itself' };
    }
    setCustomAlias(antecedent, consequent);
    return { status: 'ok', aliases: tagDbRepo.listCustomAliases() };
  });

  app.delete<{ Params: { antecedent: string } }>(
    '/tags/aliases/:antecedent',
    async (request, reply) => {
      const removed = dropCustomAlias(normalizeTag(request.params.antecedent));
      if (removed === 0) {
        reply.code(404);
        return { error: 'Alias not found' };
      }
      return { status: 'ok', aliases: tagDbRepo.listCustomAliases() };
    }
  );
};
