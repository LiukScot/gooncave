import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config } from '../config';
import { dataStore } from '../lib/dataStore';

const folderPayload = z.object({
  path: z.string().min(1, 'Path is required')
});

export const registerFolderRoutes = (app: FastifyInstance) => {
  app.get('/folders', async () => {
    if (config.folderPaths.length > 0) {
      const folders = await dataStore.ensureFolders(config.folderPaths);
      return { folders };
    }
    const folders = await dataStore.listFolders();
    return { folders };
  });

  app.post('/folders', async (request, reply) => {
    if (config.folderPaths.length > 0) {
      reply.code(403);
      return { error: 'Folder management is disabled. Configure FOLDER_PATHS on the server.' };
    }
    const parsed = folderPayload.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid folder payload', issues: parsed.error.issues };
    }

    const { path } = parsed.data;
    const existing = await dataStore.findFolderByPath(path);
    if (existing) {
      return { folder: existing, status: 'exists' };
    }

    const folder = await dataStore.addFolder(path);
    return { folder, status: 'created' };
  });

  app.delete<{ Params: { id: string } }>('/folders/:id', async (request, reply) => {
    if (config.folderPaths.length > 0) {
      reply.code(403);
      return { error: 'Folder management is disabled. Configure FOLDER_PATHS on the server.' };
    }
    const folder = await dataStore.findFolderById(request.params.id);
    if (!folder) {
      reply.code(404);
      return { error: 'Folder not found' };
    }
    if (folder.status === 'SCANNING') {
      reply.code(409);
      return { error: 'Folder is scanning; stop or wait before deleting' };
    }

    await dataStore.deleteFolder(folder.id);
    return { status: 'deleted' };
  });
};
