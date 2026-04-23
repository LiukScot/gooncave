import { FastifyInstance } from 'fastify';

import { dataStore } from '../lib/dataStore';

export const registerAdminRoutes = (app: FastifyInstance) => {
  // Clear pending/running scans and reset folders to IDLE.
  app.post('/scans/clear', async (request) => {
    await dataStore.clearPendingAndRunning(request.currentUser!.id);

    return { cleared: true };
  });
};
