import type { BooruEngineType } from '../../db/types';

import { danbooruEngine } from './danbooru';
import { e621Engine } from './e621';
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
  szurubooru: szurubooruEngine
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

export * from './types';
export {
  danbooruEngine,
  e621Engine,
  gelbooruEngine,
  moebooruEngine,
  philomenaEngine,
  sankakuEngine,
  shimmieEngine,
  szurubooruEngine
};
