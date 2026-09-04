import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { tagDbRepo } from '../db/repos/tagDbRepo';
import { normalizeTag } from '../lib/booruEngines/helpers';

const suggestSchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  /**
   * 'library' (default) suggests only what the gallery can show. 'vocabulary'
   * widens to every tag the alias tables know, for searches that run against
   * remote boorus instead.
   */
  scope: z.enum(['library', 'vocabulary']).optional()
});

export const registerTagRoutes = (app: FastifyInstance) => {
  app.get('/tags/suggest', async (request, reply) => {
    const parsed = suggestSchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid query', issues: parsed.error.issues };
    }
    // Normalised like a stored tag, so typing a space reaches the
    // underscore names the library actually holds.
    const prefix = normalizeTag(parsed.data.q ?? '');
    if (!prefix) return { suggestions: [] };
    const suggest =
      parsed.data.scope === 'vocabulary'
        ? tagDbRepo.suggestVocabulary
        : tagDbRepo.suggestTags;
    return {
      suggestions: suggest(
        request.currentUser!.id,
        prefix,
        parsed.data.limit ?? 10
      )
    };
  });
};
