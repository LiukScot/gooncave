import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config } from '../config';
import { dataStore } from '../lib/dataStore';

const folderPayload = z
  .object({
    path: z.string().min(1, 'Path is required'),
    type: z.enum(['LOCAL', 'WEBDAV']).default('LOCAL'),
    webdavUrl: z.string().url().optional(),
    webdavUsername: z.string().optional(),
    webdavPassword: z.string().optional(),
    remotePath: z.string().optional()
  })
  .refine(
    (v) => (v.type === 'WEBDAV' ? v.webdavUrl && v.webdavUsername && v.webdavPassword : true),
    { message: 'WebDAV folders require url, username, password' }
  );

const toSafeFolder = (f: any) => {
  const { webdavPassword, ...rest } = f;
  return rest;
};

export const registerFolderRoutes = (app: FastifyInstance) => {
  app.get('/folders', async () => {
    if (config.folderPaths.length > 0) {
      const folders = await dataStore.ensureFolders(config.folderPaths);
      return { folders: folders.map(toSafeFolder) };
    }
    const folders = await dataStore.listFolders();
    return { folders: folders.map(toSafeFolder) };
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

    const { path, type, webdavPassword, webdavUrl, webdavUsername, remotePath } = parsed.data;
    const existing = await dataStore.findFolderByPath(path);
    if (existing) {
      return { folder: toSafeFolder(existing), status: 'exists' };
    }

    const folder = await dataStore.addFolder(path, {
      type,
      webdavPassword,
      webdavUrl: webdavUrl ?? null,
      webdavUsername: webdavUsername ?? null,
      remotePath: remotePath ?? null
    });
    return { folder: toSafeFolder(folder), status: 'created' };
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
