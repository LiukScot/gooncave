import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { settingsRepo } from '../db/repos/settingsRepo';
import { normalizeTag } from '../lib/booruEngines/helpers';

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

// Bounded like the shortcuts blob: the settings row is not a place to park
// arbitrary data.
const MAX_BLACKLIST_TAGS = 500;

const blacklistSchema = z.object({
  tags: z.array(z.string().min(1).max(100)).max(MAX_BLACKLIST_TAGS).optional(),
  applyToExplore: z.boolean().optional(),
  applyToGallery: z.boolean().optional()
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

  app.get('/settings/blacklist', async (request) =>
    settingsRepo.getBlacklist(request.currentUser!.id)
  );

  app.put('/settings/blacklist', async (request, reply) => {
    const parsed = blacklistSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const { tags, ...rest } = parsed.data;
    // Stored the same shape the tag columns hold, so a pasted list matches
    // whatever spelling the user typed it in.
    const normalized = tags
      ? Array.from(new Set(tags.map(normalizeTag).filter(Boolean)))
      : undefined;
    return settingsRepo.saveBlacklist(
      normalized ? { ...rest, tags: normalized } : rest,
      request.currentUser!.id
    );
  });
};
