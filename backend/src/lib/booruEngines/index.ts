import type { BooruEngineType } from '../dataStore';

import { danbooruEngine } from './danbooru';
import { e621Engine } from './e621';
import { gelbooruEngine } from './gelbooru';
import { moebooruEngine } from './moebooru';
import { philomenaEngine } from './philomena';
import { sankakuEngine } from './sankaku';
import { shimmieEngine } from './shimmie';
import { szurubooruEngine } from './szurubooru';
import type { BooruEngineModule, EngineRegistry } from './types';

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

export const getEngine = (type: BooruEngineType | string): BooruEngineModule | null => {
  if (Object.prototype.hasOwnProperty.call(ENGINE_REGISTRY, type)) {
    return ENGINE_REGISTRY[type as BooruEngineType];
  }
  return null;
};

export const listEngines = (): BooruEngineModule[] => Object.values(ENGINE_REGISTRY);

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
