import { FastifyInstance } from 'fastify';

import { scansRepo } from '../db/repos/scansRepo';

export const registerAdminRoutes = (app: FastifyInstance) => {
  // Clear pending/running scans and reset folders to IDLE.
  app.post('/scans/clear', async (request) => {
    await scansRepo.clearPendingAndRunning(request.currentUser!.id);

    return { cleared: true };
  });
};
