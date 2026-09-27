import { FastifyInstance } from 'fastify';

// Contract read by native app shells before they load the site: /health,
// the /app/<tab> routes, the Gallery `fileId` and Explore `post` detail query
// parameters, and the `.app-tab-bar` class. Increment on any incompatible
// change so installed apps show an update message instead of misbehaving.
const API_VERSION = 1;

export const registerHealthRoutes = (app: FastifyInstance) => {
  app.get('/health', async () => ({
    status: 'ok',
    apiVersion: API_VERSION,
    uptimeMs: Math.round(process.uptime() * 1000)
  }));
};
