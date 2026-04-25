import fs from 'fs';
import path from 'path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStaticPlugin from '@fastify/static';
import Fastify from 'fastify';

import { config } from './config';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerCredentialRoutes } from './routes/credentials';
import { registerDuplicateRoutes } from './routes/duplicates';
import { registerFavoritesRoutes } from './routes/favorites';
import { registerFilesRoutes } from './routes/files';
import { registerFolderRoutes } from './routes/folders';
import { registerHealthRoutes } from './routes/health';
import { registerSauceRoutes } from './routes/sauces';
import { clearSessionCookie, getUserFromSessionToken } from './services/auth';

const protectedRoutePrefixes = ['/folders', '/files', '/sauces', '/duplicates', '/favorites', '/credentials', '/scans'];

const isProtectedPath = (url: string) => {
  return protectedRoutePrefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
};

export const createServer = () => {
  const app = Fastify({
    logger: true,
    disableRequestLogging: config.env === 'production'
  });

  app.register(multipart, {
    limits: {
      files: 50,
      fileSize: 5 * 1024 * 1024 * 1024
    }
  });

  app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : true,
    credentials: true
  });

  app.register(cookie);
  app.decorateRequest('currentUser', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (request, reply) => {
    request.currentUser = null;
    request.sessionToken = null;

    const token = request.cookies?.[config.auth.cookieName];
    if (token) {
      request.sessionToken = token;
      request.currentUser = await getUserFromSessionToken(token);
      if (!request.currentUser) {
        clearSessionCookie(reply);
      }
    }

    const url = request.raw.url ?? '';
    const isProtected = isProtectedPath(url);
    if (isProtected && !request.currentUser) {
      reply.code(401);
      return reply.send({ error: 'Authentication required' });
    }
  });

  try {
    fs.mkdirSync(config.storage.thumbnailsDir, { recursive: true });
  } catch (err) {
    app.log.warn({ err }, 'Failed to create thumbnails directory');
  }
  const thumbnailsRoot = path.resolve(config.storage.thumbnailsDir);
  if (fs.existsSync(thumbnailsRoot)) {
    app.register(fastifyStaticPlugin, {
      root: thumbnailsRoot,
      prefix: '/thumbnails/',
      decorateReply: false
    });
  } else {
    app.log.warn(`Thumbnails directory not found: ${thumbnailsRoot}`);
  }
  const frontendRoot = config.frontendDir ? path.resolve(config.frontendDir) : null;
  if (frontendRoot && fs.existsSync(frontendRoot)) {
    app.register(fastifyStaticPlugin, {
      root: frontendRoot,
      prefix: '/',
      decorateReply: true
    });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  }

  registerHealthRoutes(app);
  registerAuthRoutes(app);
  registerAdminRoutes(app);
  registerFolderRoutes(app);
  registerFilesRoutes(app);
  registerSauceRoutes(app);
  registerDuplicateRoutes(app);
  registerFavoritesRoutes(app);
  registerCredentialRoutes(app);

  return app;
};

const start = async () => {
  const app = createServer();
  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server listening on ${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}
