import fs from 'fs';
import path from 'path';

import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { dataStore } from '../lib/dataStore';
import type { ProviderKind } from '../lib/providerRunner';
import mime from 'mime-types';

const booleanQueryParam = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean());

const querySchema = z.object({
  folderId: z.string().optional(),
  sort: z.enum(['mtime_desc', 'mtime_asc', 'random', 'manual']).optional(),
  tags: z.string().optional(),
  seed: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  mediaType: z.enum(['IMAGE', 'VIDEO']).optional(),
  favorites: booleanQueryParam.optional()
});

const manualOrderSchema = z.object({
  order: z.array(z.string())
});

const manualTagSchema = z.object({
  tag: z.string().min(1),
  category: z.string().optional()
});

const matchRemoveSchema = z.object({
  sourceUrl: z.string().min(1)
});

const favoriteSchema = z.object({
  favorite: z.boolean()
});

const removeLocalFile = async (filePath: string) => {
  const errors: string[] = [];
  const attemptDelete = async () => {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return true;
      }
      errors.push(`File delete: ${error.message}`);
      return false;
    }
  };

  let deleted = await attemptDelete();
  if (!deleted) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    deleted = await attemptDelete();
  }

  if (deleted) {
    try {
      await fs.promises.access(filePath);
      deleted = false;
      errors.push('File still exists after delete');
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        deleted = false;
        errors.push(`File delete verify: ${error.message}`);
      }
    }
  }

  return { deleted, errors };
};

const normalizeTag = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w:()-]+/g, '')
    .toLowerCase();

const parseTagQuery = (value?: string) => {
  if (!value) return [];
  const tokens = value
    .split(/[,\s]+/)
    .map((token) => normalizeTag(token))
    .filter(Boolean);
  return Array.from(new Set(tokens));
};

const isPathInside = (candidatePath: string, basePath: string) => {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
};

const resolveSafeLocalPath = (folderPath: string, filePath: string) => {
  if (!path.isAbsolute(filePath)) {
    throw new Error('Unsafe file path: expected absolute path');
  }
  if (!isPathInside(filePath, folderPath)) {
    throw new Error('Unsafe file path: outside folder root');
  }
  return path.resolve(filePath);
};

const resolveSafeAbsolutePath = (filePath: string) => {
  if (!path.isAbsolute(filePath)) {
    throw new Error('Unsafe path: expected absolute path');
  }
  return path.resolve(filePath);
};

const encodeDownloadFilename = (filePath: string) => {
  const raw = path.basename(filePath) || 'download';
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(raw);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
};

export const registerFilesRoutes = (app: FastifyInstance) => {
  app.get('/files', async (request, reply) => {
    const userId = request.currentUser!.id;
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid query', issues: parsed.error.issues };
    }
    const { folderId, sort, tags, seed, limit, offset, mediaType, favorites } = parsed.data;
    const tagTerms = parseTagQuery(tags);
    const { files, total } = await dataStore.listFilesPage({
      folderId,
      tagTerms: tagTerms.length ? tagTerms : undefined,
      mediaType,
      favoritesOnly: favorites,
      sort,
      seed,
      limit,
      offset
    }, userId);
    const providerRunsByFile = await dataStore.listProviderRunsByFileIds(files.map((file) => file.id));
    const results = files.map((file) => {
      const runs = providerRunsByFile[file.id] ?? [];
      const providerSummary = ['SAUCENAO', 'FLUFFLE'].reduce((acc, provider) => {
        const latest = runs
          .filter((run) => run.provider === provider)
          .sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))[0];
        if (latest) {
          acc[provider] = latest;
        }
        return acc;
      }, {} as Record<string, typeof runs[number]>);
      return {
        ...file,
        thumbUrl: file.thumbPath ? `/thumbnails/${path.basename(file.thumbPath)}` : null,
        providers: providerSummary
      };
    });
    return { files: results, total };
  });

  app.put('/files/manual-order', async (request, reply) => {
    const parsed = manualOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const result = await dataStore.saveManualOrder(parsed.data.order, request.currentUser!.id);
    return { status: 'ok', saved: result.saved };
  });

  app.get<{ Params: { id: string } }>('/files/:id/tags', async (request, reply) => {
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const tags = await dataStore.listTagsForFile(file.id);
    return { tags };
  });

  app.delete<{ Params: { id: string } }>('/files/:id/tags', async (request, reply) => {
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const removed = await dataStore.clearTagsForFile(file.id);
    return { status: 'ok', removed };
  });

  app.post<{ Params: { id: string } }>('/files/:id/tags/refresh', async (request, reply) => {
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const { refreshTagsForFile } = await import('../services/tagging.js');
    await refreshTagsForFile(file);
    const tags = await dataStore.listTagsForFile(file.id);
    return { tags };
  });

  app.post<{ Params: { id: string } }>('/files/:id/matches/remove', async (request, reply) => {
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const parsed = matchRemoveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const sourceUrl = parsed.data.sourceUrl.trim();
    await dataStore.removeTagsBySourceUrl(file.id, sourceUrl);
    await dataStore.removeProviderRunResultForFile(file.id, sourceUrl);
    const { refreshTagsForFile } = await import('../services/tagging.js');
    await refreshTagsForFile(file);
    const tags = await dataStore.listTagsForFile(file.id);
    const providers = await dataStore.listProviderRuns(file.id);
    return { status: 'ok', tags, providers };
  });

  app.post<{ Params: { id: string } }>('/files/:id/tags/manual', async (request, reply) => {
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const parsed = manualTagSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const tag = parsed.data.tag.trim().replace(/\s+/g, '_').toLowerCase();
    const category = (parsed.data.category ?? 'general').trim().toLowerCase();
    await dataStore.addManualTag(file.id, tag, category);
    return { status: 'ok' };
  });

  app.delete<{ Params: { id: string } }>('/files/:id/tags/manual', async (request, reply) => {
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const parsed = manualTagSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const tag = parsed.data.tag.trim().replace(/\s+/g, '_').toLowerCase();
    await dataStore.removeManualTag(file.id, tag);
    return { status: 'ok' };
  });

  app.put<{ Params: { id: string } }>('/files/:id/favorite', async (request, reply) => {
    const parsed = favoriteSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    await dataStore.setFileFavorite(file.id, parsed.data.favorite);
    return { status: 'ok', isFavorite: parsed.data.favorite };
  });

  app.get<{ Params: { id: string } }>('/files/:id/content', async (request, reply) => {
    const userId = request.currentUser!.id;
    const file = await dataStore.findFileById(request.params.id, userId);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const folder = await dataStore.findFolderById(file.folderId, userId);
    if (!folder) {
      reply.code(404);
      return { error: 'Folder not found' };
    }
    let safeLocalPath: string | null = null;
    if (folder.type === 'LOCAL') {
      try {
        safeLocalPath = resolveSafeLocalPath(folder.path, file.path);
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }

    const query = (request.query ?? {}) as { download?: string };

    try {
      const localPath = safeLocalPath ?? file.path;
      const stat = await fs.promises.stat(localPath);
      const fileSize = stat.size;
      const range = request.headers.range;
      const contentType = mime.lookup(file.path) || 'application/octet-stream';
      reply.type(contentType);
      reply.header('X-Content-Type-Options', 'nosniff');
      if (query.download === '1') {
        reply.header('Content-Disposition', encodeDownloadFilename(file.path));
      }
      reply.header('Accept-Ranges', 'bytes');

      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          reply.code(416).header('Content-Range', `bytes */${fileSize}`);
          return reply.send();
        }

        let start: number;
        let end: number;
        if (!match[1] && match[2]) {
          const suffixLength = Number.parseInt(match[2], 10);
          if (Number.isNaN(suffixLength)) {
            reply.code(416).header('Content-Range', `bytes */${fileSize}`);
            return reply.send();
          }
          start = Math.max(fileSize - suffixLength, 0);
          end = fileSize - 1;
        } else {
          start = match[1] ? Number.parseInt(match[1], 10) : 0;
          end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
        }

        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
          reply.code(416).header('Content-Range', `bytes */${fileSize}`);
          return reply.send();
        }

        if (end >= fileSize) end = fileSize - 1;
        reply
          .code(206)
          .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
          .header('Content-Length', end - start + 1);
        const stream = fs.createReadStream(localPath, { start, end });
        stream.on('error', (err) => {
          if (!reply.sent) {
            reply.code(500).send({ error: err.message });
          }
        });
        return reply.send(stream);
      }

      reply.header('Content-Length', fileSize);
      const stream = fs.createReadStream(localPath);
      stream.on('error', (err) => {
        reply.code(500).send({ error: err.message });
      });
      return reply.send(stream);
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>('/files/:id/providers', async (request, reply) => {
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const runs = await dataStore.listProviderRuns(file.id);
    return { providers: runs };
  });

  app.post<{ Params: { id: string; provider: string } }>('/files/:id/providers/:provider', async (request, reply) => {
    const provider = request.params.provider.toUpperCase() as ProviderKind;
    if (provider !== 'SAUCENAO' && provider !== 'FLUFFLE') {
      reply.code(400);
      return { error: 'Unsupported provider' };
    }
    const file = await dataStore.findFileById(request.params.id, request.currentUser!.id);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const { executeProviderRun } = await import('../lib/providerRunner.js');
    const { providerRun, error, rateLimited, retryAt } = await executeProviderRun(file, provider);
    if (error) {
      reply.code(rateLimited ? 429 : 500);
      return { error, retryAt };
    }
    return { providerRun };
  });

  app.delete<{ Params: { id: string } }>('/files/:id', async (request, reply) => {
    const userId = request.currentUser!.id;
    const file = await dataStore.findFileById(request.params.id, userId);
    if (!file) {
      reply.code(404);
      return { error: 'File not found' };
    }
    const folder = await dataStore.findFolderById(file.folderId, userId);
    if (!folder) {
      reply.code(404);
      return { error: 'Folder not found' };
    }
    const errors: string[] = [];
    const favoritesSettings = await dataStore.getFavoritesSettings(userId);
    const favoriteItem = await dataStore.findFavoriteItemByPath(file.path, userId);
    let fileDeleted = false;
    let deletePath: string;
    try {
      deletePath = resolveSafeLocalPath(folder.path, file.path);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    const deleteResult = await removeLocalFile(deletePath);
    fileDeleted = deleteResult.deleted;
    errors.push(...deleteResult.errors);
    if (!fileDeleted) {
      console.warn(`[files] delete failed for ${file.path}: ${errors.join('; ')}`);
      reply.code(500);
      return { error: 'Failed to delete file from disk', errors };
    }
    if (favoritesSettings.reverseSyncEnabled && favoriteItem) {
      try {
        const { removeFavorite } = await import('../services/favorites.js');
        await removeFavorite(userId, favoriteItem.provider, favoriteItem.remoteId);
      } catch (err) {
        errors.push(`Unfavorite ${favoriteItem.provider}: ${(err as Error).message}`);
      }
    }
    if (file.thumbPath) {
      try {
        const safeThumbPath = resolveSafeAbsolutePath(file.thumbPath);
        await fs.promises.unlink(safeThumbPath);
      } catch (err) {
        errors.push(`Thumb delete: ${(err as Error).message}`);
      }
    }
    if (favoriteItem) {
      await dataStore.deleteFavoriteItem(favoriteItem.provider, favoriteItem.remoteId, userId);
    }
    await dataStore.deleteFile(file.id);
    return { status: 'deleted', errors: errors.length ? errors : undefined };
  });
};
