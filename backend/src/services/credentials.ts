import { config } from '../config';
import { CredentialProvider, dataStore } from '../lib/dataStore';

export type CredentialSource = 'db' | 'env' | 'none';

export type ResolvedCredential = {
  provider: CredentialProvider;
  username: string | null;
  apiKey: string | null;
  source: CredentialSource;
  updatedAt: string | null;
};

const resolveEnvCredential = (provider: CredentialProvider) => {
  if (provider === 'E621') {
    return { username: config.e621.username || null, apiKey: config.e621.apiKey || null };
  }
  if (provider === 'DANBOORU') {
    return { username: config.danbooru.username || null, apiKey: config.danbooru.apiKey || null };
  }
  return { username: null, apiKey: config.saucenao.apiKey || null };
};

export const resolveCredential = async (provider: CredentialProvider): Promise<ResolvedCredential> => {
  const stored = await dataStore.getCredential(provider);
  if (stored) {
    return {
      provider,
      username: stored.username,
      apiKey: stored.apiKey,
      source: 'db',
      updatedAt: stored.updatedAt
    };
  }
  const env = resolveEnvCredential(provider);
  const hasEnv = Boolean(env.username || env.apiKey);
  return {
    provider,
    username: env.username,
    apiKey: env.apiKey,
    source: hasEnv ? 'env' : 'none',
    updatedAt: null
  };
};

export const resolveCredentials = async (providers: CredentialProvider[]) => {
  const resolved = await Promise.all(providers.map((provider) => resolveCredential(provider)));
  return resolved;
};
