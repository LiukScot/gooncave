import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fs from 'fs';
import path from 'path';

import { config } from './config';
import { registerAdminRoutes } from './routes/admin';
import { registerFolderRoutes } from './routes/folders';
import { registerHealthRoutes } from './routes/health';
import { registerFilesRoutes } from './routes/files';
import { registerSauceRoutes } from './routes/sauces';
import { registerDuplicateRoutes } from './routes/duplicates';
import { registerFavoritesRoutes } from './routes/favorites';
import { registerCredentialRoutes } from './routes/credentials';
import { registerAuthRoutes } from './routes/auth';
import { clearSessionCookie, getUserFromSessionToken } from './services/auth';

export const createServer = () => {
  const app = Fastify({
    logger: true,
    disableRequestLogging: config.env === 'production'
  });

  app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : true
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
    const protectedPrefixes = ['/folders', '/files', '/sauces', '/duplicates', '/favorites', '/credentials', '/scans'];
    const isProtected = protectedPrefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
    if (isProtected && !request.currentUser) {
      reply.code(401);
      return reply.send({ error: 'Authentication required' });
    }
  });

  app.register(websocket);
  try {
    fs.mkdirSync(config.storage.thumbnailsDir, { recursive: true });
  } catch (err) {
    app.log.warn({ err }, 'Failed to create thumbnails directory');
  }
  const thumbnailsRoot = path.resolve(config.storage.thumbnailsDir);
  if (fs.existsSync(thumbnailsRoot)) {
    app.register(fastifyStatic, {
      root: thumbnailsRoot,
      prefix: '/thumbnails/',
      decorateReply: false
    });
  } else {
    app.log.warn(`Thumbnails directory not found: ${thumbnailsRoot}`);
  }
  const frontendRoot = config.frontendDir ? path.resolve(config.frontendDir) : null;
  if (frontendRoot && fs.existsSync(frontendRoot)) {
    app.register(fastifyStatic, {
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
