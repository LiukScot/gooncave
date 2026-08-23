import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { settingsRepo } from '../db/repos/settingsRepo';

const extraSettingsSchema = z.object({
  gamesTabEnabled: z.boolean().optional(),
  voteSystemEnabled: z.boolean().optional()
});

export const registerSettingsRoutes = (app: FastifyInstance) => {
  app.get('/settings/extra', async (request) =>
    settingsRepo.getExtraSettings(request.currentUser!.id)
  );

  app.put('/settings/extra', async (request, reply) => {
    const parsed = extraSettingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return settingsRepo.saveExtraSettings(parsed.data, request.currentUser!.id);
  });
};
