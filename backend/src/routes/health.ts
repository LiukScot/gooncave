import { FastifyInstance } from 'fastify';

export const registerHealthRoutes = (app: FastifyInstance) => {
  app.get('/health', async () => ({
    status: 'ok',
    uptimeMs: Math.round(process.uptime() * 1000)
  }));
};
