import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { CredentialProvider, dataStore } from '../lib/dataStore';
import { resolveCredential, resolveCredentials } from '../services/credentials';

const updateSchema = z.object({
  provider: z.enum(['E621', 'DANBOORU', 'SAUCENAO']),
  username: z.string().optional(),
  apiKey: z.string().optional()
});

const toPublicCredential = (credential: {
  provider: CredentialProvider;
  username: string | null;
  apiKey: string | null;
  source: 'db' | 'env' | 'none';
  updatedAt: string | null;
}) => ({
  provider: credential.provider,
  username: credential.username,
  hasApiKey: Boolean(credential.apiKey),
  source: credential.source,
  updatedAt: credential.updatedAt
});

export const registerCredentialRoutes = (app: FastifyInstance) => {
  app.get('/credentials', async (request) => {
    const providers: CredentialProvider[] = ['E621', 'DANBOORU', 'SAUCENAO'];
    const resolved = await resolveCredentials(providers, request.currentUser!.id);
    return { credentials: resolved.map(toPublicCredential) };
  });

  app.put('/credentials', async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid payload', issues: parsed.error.issues };
    }
    const { provider, username, apiKey } = parsed.data;
    const userId = request.currentUser!.id;
    await dataStore.upsertCredential(provider, { username, apiKey }, userId);
    const resolved = await resolveCredential(provider, userId);
    return { credential: toPublicCredential(resolved) };
  });
};
