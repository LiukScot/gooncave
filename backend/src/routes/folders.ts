import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config } from '../config';
import { dataStore } from '../lib/dataStore';
import { detectMediaKind, scanLocalFile } from '../lib/scanner';
import { isPathInside, resolveUserManagedPath } from '../services/auth';

const folderPayload = z.object({
  path: z.string().min(1, 'Path is required')
});

const uploadResultItem = z.object({
  name: z.string(),
  fileId: z.string().nullable().optional(),
  reason: z.string().optional()
});

const normalizeUploadName = (filename: string | undefined) => {
  const trimmed = (filename ?? '').trim();
  if (!trimmed) return null;
  const base = path.basename(trimmed);
  if (!base || base === '.' || base === '..') return null;
  return base;
};

const fileExists = async (filePath: string) => {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const listDirectChildFolders = async (libraryRoot: string) => {
  await fs.promises.mkdir(libraryRoot, { recursive: true });
  const entries = await fs.promises.readdir(libraryRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.resolve(libraryRoot, entry.name));
};

const ensureManagedFolders = async (userId: string, libraryRoot: string) => {
  const childFolders = await listDirectChildFolders(libraryRoot);
  return dataStore.ensureFolders([libraryRoot, ...childFolders], userId);
};

export const registerFolderRoutes = (app: FastifyInstance) => {
  app.get('/folders', async (request) => {
    const user = request.currentUser!;
    await ensureManagedFolders(user.id, user.libraryRoot);
    const userId = user.id;
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

  app.post<{ Params: { id: string } }>('/folders/:id/uploads', async (request, reply) => {
    const user = request.currentUser!;
    const folder = await dataStore.findFolderById(request.params.id, user.id);
    if (!folder) {
      reply.code(404);
      return { error: 'Folder not found' };
    }
    if (folder.type !== 'LOCAL') {
      reply.code(400);
      return { error: 'Only local folders support uploads' };
    }

    await fs.promises.mkdir(folder.path, { recursive: true });

    const uploaded: Array<z.infer<typeof uploadResultItem>> = [];
    const rejected: Array<z.infer<typeof uploadResultItem>> = [];
    const reservedPaths = new Set<string>();

    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;

      const safeName = normalizeUploadName(part.filename);
      const fallbackName = part.filename?.trim() || 'unnamed file';
      if (!safeName) {
        part.file.resume();
        rejected.push({ name: fallbackName, reason: 'Invalid file name' });
        continue;
      }
      if (!detectMediaKind(safeName)) {
        part.file.resume();
        rejected.push({ name: safeName, reason: 'Unsupported file type' });
        continue;
      }

      const targetPath = path.resolve(folder.path, safeName);
      if (!isPathInside(targetPath, folder.path)) {
        part.file.resume();
        rejected.push({ name: safeName, reason: 'Unsafe upload path' });
        continue;
      }
      if (reservedPaths.has(targetPath) || (await fileExists(targetPath))) {
        part.file.resume();
        rejected.push({ name: safeName, reason: 'A file with this name already exists in the folder' });
        continue;
      }

      reservedPaths.add(targetPath);
      try {
        await pipeline(part.file, fs.createWriteStream(targetPath, { flags: 'wx' }));
        const scanned = await scanLocalFile(targetPath, { thumbnailsDir: config.storage.thumbnailsDir });
        if (!scanned) {
          await fs.promises.unlink(targetPath).catch(() => undefined);
          rejected.push({ name: safeName, reason: 'Unsupported file type' });
          continue;
        }
        const saved = await dataStore.upsertFile(folder.id, scanned);
        uploaded.push({ name: safeName, fileId: saved.id });
      } catch (error) {
        await fs.promises.unlink(targetPath).catch(() => undefined);
        const err = error as NodeJS.ErrnoException;
        const reason = err.code === 'EEXIST'
          ? 'A file with this name already exists in the folder'
          : (err.message || 'Failed to upload file');
        rejected.push({ name: safeName, reason });
      } finally {
        reservedPaths.delete(targetPath);
      }
    }

    if (uploaded.length === 0 && rejected.length === 0) {
      reply.code(400);
      return { error: 'No files were provided' };
    }

    return { uploaded, rejected };
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
