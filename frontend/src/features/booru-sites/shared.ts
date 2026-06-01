import type { BooruCredentialSchema, BooruEngineType } from '@/api';

export const ENGINE_LABELS: Record<BooruEngineType, string> = {
  danbooru: 'Danbooru',
  e621: 'e621',
  moebooru: 'Moebooru (yande.re / konachan)',
  gelbooru: 'Gelbooru',
  sankaku: 'Sankaku',
  philomena: 'Philomena (Derpibooru)',
  shimmie: 'Shimmie2',
  szurubooru: 'Szurubooru'
};

export const credentialFieldsForSchema = (schema: BooruCredentialSchema) => {
  switch (schema) {
    case 'username+apikey':
      return {
        username: true,
        usernameLabel: 'Username',
        apiKey: true,
        apiKeyLabel: 'API key'
      };
    case 'userid+apikey':
      return {
        username: true,
        usernameLabel: 'User ID',
        apiKey: true,
        apiKeyLabel: 'API key'
      };
    case 'apikey-only':
      return {
        username: false,
        usernameLabel: '',
        apiKey: true,
        apiKeyLabel: 'API key'
      };
    case 'token':
      return {
        username: false,
        usernameLabel: '',
        apiKey: true,
        apiKeyLabel: 'Token'
      };
    case 'none':
    default:
      return {
        username: false,
        usernameLabel: '',
        apiKey: false,
        apiKeyLabel: ''
      };
  }
};
