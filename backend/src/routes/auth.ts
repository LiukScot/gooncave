import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { clearSessionCookie, createSessionForUser, loginLocalUser, registerLocalUser, setSessionCookie, toPublicUser } from '../services/auth';
import { dataStore } from '../lib/dataStore';

const authSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, _ and -'),
  password: z.string().min(8, 'Password must be at least 8 characters')
});

export const registerAuthRoutes = (app: FastifyInstance) => {
  app.get('/auth/me', async (request, reply) => {
    if (!request.currentUser) {
      reply.code(401);
      return { error: 'Not authenticated' };
    }
    return { user: toPublicUser(request.currentUser) };
  });

  app.post('/auth/register', async (request, reply) => {
    const parsed = authSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    try {
      const user = await registerLocalUser(parsed.data.username, parsed.data.password);
      const session = await createSessionForUser(user.id);
      setSessionCookie(reply, session.token, session.expiresAt);
      return { user: toPublicUser(user) };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = authSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    try {
      const user = await loginLocalUser(parsed.data.username, parsed.data.password);
      const session = await createSessionForUser(user.id);
      setSessionCookie(reply, session.token, session.expiresAt);
      return { user: toPublicUser(user) };
    } catch (err) {
      reply.code(401);
      return { error: (err as Error).message };
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.sessionToken) {
      await dataStore.deleteSessionByToken(request.sessionToken);
    }
    clearSessionCookie(reply);
    return { status: 'ok' };
  });
};
