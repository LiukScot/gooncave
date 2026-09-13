import fs from 'node:fs';

import { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { config } from '../config';
import { SsrfBlockedError } from '../lib/ssrfGuard';
import {
  REMOTE_MEDIA_ROUTE,
  remoteMediaCache,
  RemoteMediaError
} from '../services/remoteMedia';

const mediaSchema = z.object({
  u: z.string().url().max(4000),
  s: z.string().min(1).max(100)
});

// A cached file never changes under its url, so the browser may keep it as
// long as the server does.
const CACHED_MEDIA_CACHE_CONTROL = `private, max-age=${Math.floor(
  config.remoteMedia.maxAgeMs / 1000
)}, immutable`;

const isMissingFile = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

export const registerRemoteMediaRoutes = (app: FastifyInstance) => {
  app.get(
    REMOTE_MEDIA_ROUTE,
    // A grid page is dozens of these at once; the cap only stops a runaway.
    { config: { rateLimit: { max: 2000, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = mediaSchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: 'Invalid query', issues: parsed.error.issues };
      }
      const { u: url, s: signature } = parsed.data;
      if (!remoteMediaCache.verify(url, signature)) {
        reply.code(403);
        return { error: 'Invalid media signature' };
      }
      try {
        const media = await remoteMediaCache.load(url);
        // Opened here, not by the stream: a prune can delete the file after
        // load() returns, and that has to answer like any other miss.
        const file = await fs.promises.open(media.filePath, 'r');
        return reply
          .type(media.contentType)
          .header('Cache-Control', CACHED_MEDIA_CACHE_CONTROL)
          .header('X-Content-Type-Options', 'nosniff')
          // Opened directly in a tab, the response still runs no script.
          .header('Content-Security-Policy', "default-src 'none'; sandbox")
          .send(file.createReadStream());
      } catch (error) {
        if (
          !(error instanceof RemoteMediaError) &&
          !(error instanceof SsrfBlockedError) &&
          !isMissingFile(error)
        ) {
          throw error;
        }
        request.log.warn(
          { host: new URL(url).host, err: (error as Error).message },
          'remote media unavailable'
        );
        // Not cached by the browser: the image is retried, and a later try
        // can succeed once the booru stops refusing.
        reply.code(502).header('Cache-Control', 'no-store');
        return { error: 'Media unavailable from the booru' };
      }
    }
  );
};
