import 'fastify';

import type { AuthenticatedUser } from './services/auth';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: AuthenticatedUser | null;
    sessionToken: string | null;
  }
}
