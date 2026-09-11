import type { BooruEngineType, BooruSiteRecord } from '../../db/types';

import { danbooruEngine } from './danbooru';
import { e621Engine } from './e621';
import { furaffinityEngine } from './furaffinity';
import { gelbooruEngine } from './gelbooru';
import { moebooruEngine } from './moebooru';
import { philomenaEngine } from './philomena';
import { sankakuEngine } from './sankaku';
import { shimmieEngine } from './shimmie';
import { szurubooruEngine } from './szurubooru';
import type {
  BooruEngineModule,
  EngineCapabilityDefaults,
  EngineRegistry
} from './types';

export const ENGINE_REGISTRY: EngineRegistry = {
  danbooru: danbooruEngine,
  e621: e621Engine,
  moebooru: moebooruEngine,
  gelbooru: gelbooruEngine,
  sankaku: sankakuEngine,
  philomena: philomenaEngine,
  shimmie: shimmieEngine,
  szurubooru: szurubooruEngine,
  furaffinity: furaffinityEngine
};

export const getEngine = (
  type: BooruEngineType | string
): BooruEngineModule | null => {
  if (Object.prototype.hasOwnProperty.call(ENGINE_REGISTRY, type)) {
    return ENGINE_REGISTRY[type as BooruEngineType];
  }
  return null;
};

export const listEngines = (): BooruEngineModule[] =>
  Object.values(ENGINE_REGISTRY);

// Capabilities are an inherent property of the engine, not a per-site setting.
// Single source of truth for "can this site do X" — derived from the engine
// module the site runs on. Unknown engine → no capabilities.
export const engineSupports = (
  engine: BooruEngineType | string,
  capability: keyof EngineCapabilityDefaults
): boolean => getEngine(engine)?.defaultCapabilities[capability] ?? false;

export const engineCredentialsReady = (site: BooruSiteRecord): boolean => {
  const schema = getEngine(site.engine)?.credentialSchema;
  switch (schema) {
    case 'username+apikey':
    case 'userid+apikey':
      return Boolean(site.username && site.apiKey);
    case 'username+session-cookie':
      return Boolean(site.username && site.sessionCookie);
    case 'apikey-only':
    case 'token':
      return Boolean(site.apiKey);
    case 'none':
      return true;
    default:
      return false;
  }
};

export const engineCredentialError = (
  site: BooruSiteRecord
): string | null => {
  if (engineCredentialsReady(site)) return null;
  const schema = getEngine(site.engine)?.credentialSchema;
  const fields = (() => {
    switch (schema) {
      case 'username+session-cookie':
        return 'a username and session cookie';
      case 'username+apikey':
        return 'a username and API key';
      case 'userid+apikey':
        return 'a user ID and API key';
      case 'apikey-only':
        return 'an API key';
      case 'token':
        return 'a token';
      default:
        return 'configured credentials';
    }
  })();
  return `${site.name} needs ${fields}: add them under Settings → Favorites accounts`;
};

export * from './types';
export {
  danbooruEngine,
  e621Engine,
  furaffinityEngine,
  gelbooruEngine,
  moebooruEngine,
  philomenaEngine,
  sankakuEngine,
  shimmieEngine,
  szurubooruEngine
};
