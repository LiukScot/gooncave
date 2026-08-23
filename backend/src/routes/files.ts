import fs from 'fs';
import path from 'path';

import { FastifyInstance } from 'fastify';
import { lookup as lookupMime } from 'mime-types';
import { z } from 'zod';

import { config } from '../config';
import { booruSitesRepo } from '../db/repos/booruSitesRepo';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import { foldersRepo } from '../db/repos/foldersRepo';
import { normalizeTag } from '../lib/booruEngines/helpers';
import { providerKinds } from '../lib/providerRunner';
import type { ProviderKind } from '../lib/providerRunner';
import { isPathInside } from '../services/auth';

const querySchema = z.object({
  folderId: z.string().optional(),
  sort: z.enum(['mtime_desc', 'mtime_asc', 'random', 'rated']).optional(),
  tags: z.string().optional(),
  seed: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  mediaType: z.enum(['IMAGE', 'VIDEO']).optional()
});

const manualTagSchema = z.object({
  tag: z.string().min(1),
  category: z.string().optional()
});

const matchRemoveSchema = z.object({
  sourceUrl: z.string().min(1)
});

const voteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1)])
});

const fileContentRateLimit = {
  max: 300,
  timeWindow: '1 minute'
};
const fileDeleteRateLimit = {
  max: 30,
  timeWindow: '1 minute'
};
const fileProviderRunRateLimit = {
  max: 20,
  timeWindow: '1 minute'
};
const fileVoteRateLimit = {
  max: 60,
  timeWindow: '1 minute'
};

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

const parseTagQuery = (value?: string) => {
  if (!value) return [];
  const tokens = value
    .split(/[,\s]+/)
    .map((token) => normalizeTag(token))
    .filter(Boolean);
  return Array.from(new Set(tokens));
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
    const { folderId, sort, tags, seed, limit, offset, mediaType } =
      parsed.data;
    const tagTerms = parseTagQuery(tags);
    const { files, total } = await filesRepo.listFilesPage(
      {
        folderId,
        tagTerms: tagTerms.length ? tagTerms : undefined,
        mediaType,
        sort,
        seed,
        limit,
        offset
      },
      userId
    );
    const providerRunsByFile = await filesRepo.listProviderRunsByFileIds(
      files.map((file) => file.id)
    );
    const results = files.map((file) => {
      const runs = providerRunsByFile[file.id] ?? [];
      const providerSummary = providerKinds.reduce(
        (acc, provider) => {
          const latest = runs.find((run) => run.provider === provider);
          if (latest) {
            acc[provider] = latest;
          }
          return acc;
        },
        {} as Record<string, (typeof runs)[number]>
      );
      return {
        ...file,
        thumbUrl: file.thumbPath
          ? `/thumbnails/${path.basename(file.thumbPath)}`
          : null,
        providers: providerSummary
      };
    });
    return { files: results, total };
  });

  app.get<{ Params: { id: string } }>(
    '/files/:id/tags',
    async (request, reply) => {
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const tags = await filesRepo.listTagsForFile(file.id);
      return { tags };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/files/:id/tags',
    async (request, reply) => {
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const removed = await filesRepo.clearTagsForFile(file.id);
      return { status: 'ok', removed };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/files/:id/tags/refresh',
    async (request, reply) => {
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const { refreshTagsForFile } = await import('../services/tagging.js');
      await refreshTagsForFile(file);
      const tags = await filesRepo.listTagsForFile(file.id);
      return { tags };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/files/:id/matches/remove',
    async (request, reply) => {
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
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
      await filesRepo.removeTagsBySourceUrl(file.id, sourceUrl);
      await filesRepo.removeProviderRunResultForFile(file.id, sourceUrl);
      const { refreshTagsForFile } = await import('../services/tagging.js');
      await refreshTagsForFile(file);
      const tags = await filesRepo.listTagsForFile(file.id);
      const providers = await filesRepo.listProviderRuns(file.id);
      return { status: 'ok', tags, providers };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/files/:id/tags/manual',
    async (request, reply) => {
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
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
      await filesRepo.addManualTag(file.id, tag, category);
      return { status: 'ok' };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/files/:id/tags/manual',
    async (request, reply) => {
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
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
      await filesRepo.removeManualTag(file.id, tag);
      return { status: 'ok' };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/files/:id/vote',
    { config: { rateLimit: fileVoteRateLimit } },
    async (request, reply) => {
      const parsed = voteSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid payload', issues: parsed.error.issues };
      }
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const result = await filesRepo.applyFileVote(file.id, parsed.data.value);
      if (!result.applied) {
        reply.code(409);
        return {
          error:
            result.reason === 'floor'
              ? 'This file is already at zero and cannot go lower.'
              : 'This file was already voted in the last 24 hours.',
          voteScore: result.voteScore,
          nextVoteAt: result.nextVoteAt
        };
      }
      return {
        status: 'ok',
        voteScore: result.voteScore,
        nextVoteAt: result.nextVoteAt
      };
    }
  );

  app.get<{ Params: { id: string } }>(
    '/files/:id/content',
    {
      config: {
        rateLimit: fileContentRateLimit
      }
    },
    async (request, reply) => {
      const userId = request.currentUser!.id;
      const file = await filesRepo.findFileById(request.params.id, userId);
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const folder = await foldersRepo.findFolderById(file.folderId, userId);
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
        const contentType = lookupMime(file.path) || 'application/octet-stream';
        reply.type(contentType);
        reply.header('X-Content-Type-Options', 'nosniff');
        if (query.download === '1') {
          reply.header(
            'Content-Disposition',
            encodeDownloadFilename(file.path)
          );
        }
        reply.header('Accept-Ranges', 'bytes');

        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2])) {
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

          if (
            Number.isNaN(start) ||
            Number.isNaN(end) ||
            start > end ||
            start >= fileSize
          ) {
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
            request.log.error({ err }, 'file content stream error');
            if (!reply.sent) {
              reply.code(500).send({ error: 'Internal server error' });
            }
          });
          return reply.send(stream);
        }

        reply.header('Content-Length', fileSize);
        const stream = fs.createReadStream(localPath);
        stream.on('error', (err) => {
          request.log.error({ err }, 'file content stream error');
          if (!reply.sent) {
            reply.code(500).send({ error: 'Internal server error' });
          }
        });
        return reply.send(stream);
      } catch (err) {
        request.log.error({ err }, 'file content error');
        reply.code(500);
        return { error: 'Internal server error' };
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    '/files/:id/providers',
    async (request, reply) => {
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const runs = await filesRepo.listProviderRuns(file.id);
      return { providers: runs };
    }
  );

  app.post<{ Params: { id: string; provider: string } }>(
    '/files/:id/providers/:provider',
    { config: { rateLimit: fileProviderRunRateLimit } },
    async (request, reply) => {
      const upperProvider = request.params.provider.toUpperCase();
      if (upperProvider !== 'SAUCENAO' && upperProvider !== 'FLUFFLE') {
        reply.code(400);
        return { error: 'Unsupported provider' };
      }
      const provider = upperProvider as ProviderKind;
      const file = await filesRepo.findFileById(
        request.params.id,
        request.currentUser!.id
      );
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const { executeProviderRun } = await import('../lib/providerRunner.js');
      const { providerRun, error, rateLimited, retryAt } =
        await executeProviderRun(file, provider);
      if (error) {
        reply.code(rateLimited ? 429 : 500);
        return { error, retryAt };
      }
      return { providerRun };
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/files/:id',
    {
      config: {
        rateLimit: fileDeleteRateLimit
      }
    },
    async (request, reply) => {
      const userId = request.currentUser!.id;
      const file = await filesRepo.findFileById(request.params.id, userId);
      if (!file) {
        reply.code(404);
        return { error: 'File not found' };
      }
      const folder = await foldersRepo.findFolderById(file.folderId, userId);
      if (!folder) {
        reply.code(404);
        return { error: 'Folder not found' };
      }
      const errors: string[] = [];
      const favoriteItems = await favoritesRepo.listFavoriteItemsByPath(
        file.path,
        userId
      );
      let deletePath: string;
      try {
        deletePath = resolveSafeLocalPath(folder.path, file.path);
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
      const deleteResult = await removeLocalFile(deletePath);
      errors.push(...deleteResult.errors);
      if (!deleteResult.deleted) {
        request.log.warn({ fileId: file.id, errors }, 'file delete failed');
        reply.code(500);
        return { error: 'Failed to delete file from disk', errors };
      }
      if (favoriteItems.length > 0) {
        for (const favoriteItem of favoriteItems) {
          const targetSite =
            (await booruSitesRepo.getBooruSite(
              favoriteItem.provider,
              userId
            )) ??
            (await booruSitesRepo.findBooruSiteByPresetKey(
              favoriteItem.provider,
              userId
            ));
          if (!targetSite?.siteReverseSyncEnabled) continue;
          try {
            const { removeFavorite } = await import('../services/favorites.js');
            await removeFavorite(
              userId,
              favoriteItem.provider,
              favoriteItem.remoteId
            );
          } catch (err) {
            errors.push(
              `Unfavorite ${favoriteItem.provider}: ${(err as Error).message}`
            );
          }
        }
      }
      if (file.thumbPath) {
        try {
          // Thumbs live in thumbnailsDir keyed by basename — same contract as
          // how they're served and stored. thumbPath is relative, so resolve
          // against the thumbnails root; using basename also keeps the unlink
          // inside that directory (no path traversal).
          const thumbAbs = path.join(
            path.resolve(config.storage.thumbnailsDir),
            path.basename(file.thumbPath)
          );
          await fs.promises.unlink(thumbAbs);
        } catch (err) {
          // Already gone = goal met (idempotent delete); anything else is real.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            errors.push(`Thumb delete: ${(err as Error).message}`);
          }
        }
      }
      for (const favoriteItem of favoriteItems) {
        try {
          await favoritesRepo.deleteFavoriteItem(
            favoriteItem.provider,
            favoriteItem.remoteId,
            userId
          );
        } catch (err) {
          errors.push(
            `DB favorite delete (${favoriteItem.provider}/${favoriteItem.remoteId}): ${(err as Error).message}`
          );
        }
      }
      try {
        await filesRepo.deleteFile(file.id);
      } catch (err) {
        errors.push(`DB file delete: ${(err as Error).message}`);
      }
      return { status: 'deleted', errors: errors.length ? errors : undefined };
    }
  );
};
