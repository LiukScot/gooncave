import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { settingsRepo } from '../db/repos/settingsRepo';

const extraSettingsSchema = z.object({
  gamesTabEnabled: z.boolean().optional(),
  voteSystemEnabled: z.boolean().optional()
});

// Values are `KeyboardEvent.key` strings. Bounded on all three axes — key
// length, value length and entry count — so the settings row cannot become
// a place to park arbitrary data.
const MAX_SHORTCUT_BINDINGS = 64;

const shortcutsSchema = z.object({
  bindings: z
    .record(z.string().min(1).max(32), z.string().min(1).max(32))
    .refine(
      (bindings) => Object.keys(bindings).length <= MAX_SHORTCUT_BINDINGS,
      { message: `At most ${MAX_SHORTCUT_BINDINGS} bindings` }
    )
});

export const registerSettingsRoutes = (app: FastifyInstance) => {
  app.get('/settings/shortcuts', async (request) => ({
    bindings: settingsRepo.getShortcuts(request.currentUser!.id)
  }));

  app.put('/settings/shortcuts', async (request, reply) => {
    const parsed = shortcutsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    return {
      bindings: settingsRepo.saveShortcuts(
        request.currentUser!.id,
        parsed.data.bindings
      )
    };
  });

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
