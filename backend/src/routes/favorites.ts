import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { dataStore } from '../lib/dataStore';
import { DirectoryWriteAccessError } from '../lib/fsAccess';

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
  app.get('/favorites/settings', async (request) => {
    return dataStore.getFavoritesSettings(request.currentUser!.id);
  });

  app.put('/favorites/settings', async (request, reply) => {
    const userId = request.currentUser!.id;
    const parsed = settingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    if (parsed.data.favoritesRootId !== undefined && parsed.data.favoritesRootId !== null) {
      const folder = await dataStore.findFolderById(parsed.data.favoritesRootId, userId);
      if (!folder) {
        reply.code(404);
        return { error: 'Folder not found' };
      }
      if (folder.type !== 'LOCAL') {
        reply.code(400);
        return { error: 'Favorites sync requires a local folder.' };
      }
    }
    return dataStore.saveFavoritesSettings(parsed.data, userId);
  });

  app.get('/favorites/sync/status', async (request) => {
    const { getFavoritesSyncStatus } = await import('../services/favorites.js');
    return getFavoritesSyncStatus(request.currentUser!.id);
  });

  app.post('/favorites/sync', async (request, reply) => {
    const userId = request.currentUser!.id;
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
    const { assertFavoritesSyncReady, startFavoritesSync } = await import('../services/favorites.js');
    try {
      await assertFavoritesSyncReady(userId);
    } catch (error) {
      if (error instanceof DirectoryWriteAccessError) {
        reply.code(409);
        return { error: error.message };
      }
      if (error instanceof Error && /favorites root not configured/i.test(error.message)) {
        reply.code(400);
        return { error: error.message };
      }
      throw error;
    }
    return startFavoritesSync(userId, { providers, deleteMissing: parsed.data.deleteMissing });
  });
};
