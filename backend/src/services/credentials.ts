import { CredentialProvider, dataStore } from '../lib/dataStore';

export type CredentialSource = 'db' | 'none';

export type ResolvedCredential = {
  provider: CredentialProvider;
  username: string | null;
  apiKey: string | null;
  source: CredentialSource;
  updatedAt: string | null;
};

export const resolveCredential = async (provider: CredentialProvider, userId?: string): Promise<ResolvedCredential> => {
  if (!userId) {
    return {
      provider,
      username: null,
      apiKey: null,
      source: 'none',
      updatedAt: null
    };
  }
  const stored = await dataStore.getCredential(provider, userId);
  if (stored) {
    return {
      provider,
      username: stored.username,
      apiKey: stored.apiKey,
      source: 'db',
      updatedAt: stored.updatedAt
    };
  }
  return {
    provider,
    username: null,
    apiKey: null,
    source: 'none',
    updatedAt: null
  };
};

export const resolveCredentials = async (providers: CredentialProvider[], userId?: string) => {
  const resolved = await Promise.all(providers.map((provider) => resolveCredential(provider, userId)));
  return resolved;
};
