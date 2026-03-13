import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { dataStore } from '../lib/dataStore';

const syncSchema = z.object({
  providers: z.array(z.string()).optional(),
  deleteMissing: z.boolean().optional()
});

const settingsSchema = z.object({
  reverseSyncEnabled: z.boolean().optional(),
  autoSyncMidnight: z.boolean().optional(),
  favoritesRootId: z.string().nullable().optional()
});

const toProvider = (value: string) => value.trim().toUpperCase();

export const registerFavoritesRoutes = (app: FastifyInstance) => {
  app.get('/favorites/settings', async () => {
    return dataStore.getFavoritesSettings();
  });

  app.put('/favorites/settings', async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    if (parsed.data.favoritesRootId !== undefined && parsed.data.favoritesRootId !== null) {
      const folder = await dataStore.findFolderById(parsed.data.favoritesRootId);
      if (!folder) {
        reply.code(404);
        return { error: 'Folder not found' };
      }
      if (folder.type !== 'LOCAL') {
        reply.code(400);
        return { error: 'Favorites sync requires a local folder.' };
      }
    }
    return dataStore.saveFavoritesSettings(parsed.data);
  });

  app.get('/favorites/sync/status', async () => {
    const { getFavoritesSyncStatus } = await import('../services/favorites');
    return getFavoritesSyncStatus();
  });

  app.post('/favorites/sync', async (request, reply) => {
    const parsed = syncSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const providers = parsed.data.providers
      ? parsed.data.providers.map(toProvider).filter((provider) => provider === 'E621' || provider === 'DANBOORU')
      : undefined;
    if (parsed.data.providers && (!providers || providers.length === 0)) {
      reply.code(400);
      return { error: 'No valid providers provided (use E621 or DANBOORU).' };
    }
    const { startFavoritesSync } = await import('../services/favorites');
    return startFavoritesSync({ providers, deleteMissing: parsed.data.deleteMissing });
  });
};
