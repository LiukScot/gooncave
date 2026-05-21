import type { BooruEngineType } from '../dataStore';

export type BooruPreset = {
  key: string;
  name: string;
  engine: BooruEngineType;
  baseUrl: string;
  defaultCapabilities: {
    favorites: boolean;
    tags: boolean;
    sourceMatch: boolean;
    search: boolean;
  };
};

export const BOORU_PRESETS: BooruPreset[] = [
  {
    key: 'E621',
    name: 'e621',
    engine: 'e621',
    baseUrl: 'https://e621.net',
    defaultCapabilities: { favorites: true, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'E926',
    name: 'e926',
    engine: 'e621',
    baseUrl: 'https://e926.net',
    defaultCapabilities: { favorites: true, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'DANBOORU',
    name: 'Danbooru',
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us',
    defaultCapabilities: { favorites: true, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'GELBOORU',
    name: 'Gelbooru',
    engine: 'gelbooru',
    baseUrl: 'https://gelbooru.com',
    defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'RULE34',
    name: 'Rule34',
    engine: 'gelbooru',
    baseUrl: 'https://rule34.xxx',
    defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'YANDERE',
    name: 'yande.re',
    engine: 'moebooru',
    baseUrl: 'https://yande.re',
    defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'KONACHAN',
    name: 'Konachan',
    engine: 'moebooru',
    baseUrl: 'https://konachan.com',
    defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'SANKAKU',
    name: 'Sankaku Channel',
    engine: 'sankaku',
    baseUrl: 'https://chan.sankakucomplex.com',
    defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'IDOL_COMPLEX',
    name: 'Idol Complex',
    engine: 'sankaku',
    baseUrl: 'https://idol.sankakucomplex.com',
    defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true }
  },
  {
    key: 'DERPIBOORU',
    name: 'Derpibooru',
    engine: 'philomena',
    baseUrl: 'https://derpibooru.org',
    defaultCapabilities: { favorites: false, tags: true, sourceMatch: true, search: true }
  }
];

export const findPresetByKey = (key: string): BooruPreset | null =>
  BOORU_PRESETS.find((preset) => preset.key === key) ?? null;
