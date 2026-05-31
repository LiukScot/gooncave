import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { favoritesRepo } from '../db/repos/favoritesRepo';
import { foldersRepo } from '../db/repos/foldersRepo';
import { DirectoryWriteAccessError } from '../lib/fsAccess';

const syncSchema = z.object({
  providers: z.array(z.string()).optional(),
  deleteMissing: z.boolean().optional()
});

const settingsSchema = z.object({
  favoritesRootId: z.string().nullable().optional()
});

export const registerFavoritesRoutes = (app: FastifyInstance) => {
  app.get('/favorites/settings', async (request) => {
    return favoritesRepo.getFavoritesSettings(request.currentUser!.id);
  });

  app.put('/favorites/settings', async (request, reply) => {
    const userId = request.currentUser!.id;
    const parsed = settingsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    if (
      parsed.data.favoritesRootId !== undefined &&
      parsed.data.favoritesRootId !== null
    ) {
      const folder = await foldersRepo.findFolderById(
        parsed.data.favoritesRootId,
        userId
      );
      if (!folder) {
        reply.code(404);
        return { error: 'Folder not found' };
      }
      if (folder.type !== 'LOCAL') {
        reply.code(400);
        return { error: 'Favorites sync requires a local folder.' };
      }
    }
    return favoritesRepo.saveFavoritesSettings(parsed.data, userId);
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
    // providers can be either a legacy preset key ('E621', 'DANBOORU', ...) or a
    // user_booru_sites.id UUID. The sync service resolves either form back to a
    // BooruSiteRecord, so we just pass strings through here without filtering.
    const providers = parsed.data.providers
      ?.map((value) => value.trim())
      .filter(Boolean);
    if (parsed.data.providers && (!providers || providers.length === 0)) {
      reply.code(400);
      return { error: 'No valid providers provided.' };
    }
    const { assertFavoritesSyncReady, startFavoritesSync } =
      await import('../services/favorites.js');
    try {
      await assertFavoritesSyncReady(userId);
    } catch (error) {
      if (error instanceof DirectoryWriteAccessError) {
        reply.code(409);
        return { error: error.message };
      }
      if (
        error instanceof Error &&
        /favorites root not configured/i.test(error.message)
      ) {
        reply.code(400);
        return { error: error.message };
      }
      throw error;
    }
    return startFavoritesSync(userId, {
      providers,
      deleteMissing: parsed.data.deleteMissing
    });
  });
};
