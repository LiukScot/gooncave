import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { dataStore } from '../lib/dataStore';
import { resolveUserManagedPath } from '../services/auth';

const folderPayload = z.object({
  path: z.string().min(1, 'Path is required')
});

export const registerFolderRoutes = (app: FastifyInstance) => {
  app.get('/folders', async (request) => {
    const userId = request.currentUser!.id;
    const folders = await dataStore.listFolders(userId);
    return { folders };
  });

  app.post('/folders', async (request, reply) => {
    const parsed = folderPayload.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid folder payload', issues: parsed.error.issues };
    }

    const user = request.currentUser!;
    let resolvedPath: string;
    try {
      resolvedPath = await resolveUserManagedPath(user.libraryRoot, parsed.data.path);
    } catch (error) {
      if (error instanceof Error && /outside.*library root|library root.*outside/i.test(error.message)) {
        reply.code(400);
        return {
          error: 'Folder path must be inside your library root',
          details: 'Choose a folder within your configured library root.'
        };
      }

      throw error;
    }
    const existing = await dataStore.findFolderByPath(resolvedPath, user.id);
    if (existing) {
      return { folder: existing, status: 'exists' };
    }

    const folder = await dataStore.addFolder(resolvedPath, user.id);
    return { folder, status: 'created' };
  });

  app.delete<{ Params: { id: string } }>('/folders/:id', async (request, reply) => {
    const user = request.currentUser!;
    const folder = await dataStore.findFolderById(request.params.id, user.id);
    if (!folder) {
      reply.code(404);
      return { error: 'Folder not found' };
    }
    if (folder.path === user.libraryRoot) {
      reply.code(400);
      return { error: 'Cannot remove your library root folder' };
    }
    if (folder.status === 'SCANNING') {
      reply.code(409);
      return { error: 'Folder is scanning; stop or wait before deleting' };
    }

    await dataStore.deleteFolder(folder.id, user.id);
    return { status: 'deleted' };
  });
};
