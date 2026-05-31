import fs from 'fs';
import path from 'path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStaticPlugin from '@fastify/static';
import Fastify from 'fastify';

import { config } from './config';
import { runMigrations } from './db/migrate';
import { seedBooruSitesFromLegacyCredentials } from './lib/booruSitesSeed';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthRoutes } from './routes/auth';
import { registerBooruSiteRoutes } from './routes/booruSites';
import { registerCredentialRoutes } from './routes/credentials';
import { registerDuplicateRoutes } from './routes/duplicates';
import { registerFavoritesRoutes } from './routes/favorites';
import { registerFilesRoutes } from './routes/files';
import { registerFolderRoutes } from './routes/folders';
import { registerHealthRoutes } from './routes/health';
import { registerSauceRoutes } from './routes/sauces';
import { clearSessionCookie, getUserFromSessionToken } from './services/auth';

const protectedRoutePrefixes = [
  '/folders',
  '/files',
  '/sauces',
  '/duplicates',
  '/favorites',
  '/credentials',
  '/booru-sites',
  '/scans',
  '/thumbnails'
];
const spaRoutePrefixes = ['/login', '/app'];

const isProtectedPath = (url: string) => {
  const pathname = new URL(url, 'http://x').pathname;
  return protectedRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
};

const isSpaRoutePath = (pathname: string) =>
  spaRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

export const createServer = (options?: { frontendDir?: string | null }) => {
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

  if (config.allowedOrigins.length === 0) {
    app.log.warn(
      'ALLOWED_ORIGINS is empty; cross-origin requests will be rejected'
    );
  }
  app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
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
  const frontendRootSource = options?.frontendDir ?? config.frontendDir;
  const frontendRoot = frontendRootSource
    ? path.resolve(frontendRootSource)
    : null;
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
  registerBooruSiteRoutes(app);

  if (frontendRoot && fs.existsSync(frontendRoot)) {
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = new URL(request.url, 'http://x').pathname;
      const acceptsHtml =
        request.headers.accept?.includes('text/html') ?? false;
      const isHtmlNavigation =
        request.method === 'GET' && acceptsHtml && !path.extname(pathname);
      if (isHtmlNavigation && isSpaRoutePath(pathname)) {
        return reply.type('text/html').sendFile('index.html');
      }
      reply.code(404);
      return reply.send({
        message: `Route ${request.method}:${pathname} not found`,
        error: 'Not Found',
        statusCode: 404
      });
    });
  }

  return app;
};

const start = async () => {
  const app = createServer();
  try {
    runMigrations();
    const seedResult = await seedBooruSitesFromLegacyCredentials();
    if (seedResult.insertedRows > 0) {
      app.log.info(
        { ...seedResult },
        `Seeded ${seedResult.insertedRows} booru preset row(s) from existing credentials`
      );
    }
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Server listening on ${config.host}:${config.port}`);
    if (process.env.API_EXIT_AFTER_BOOT === 'true') {
      await app.close();
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}
