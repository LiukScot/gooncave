import type { BooruEngineType } from '../../db/types';

export type BooruPreset = {
  key: string;
  name: string;
  engine: BooruEngineType;
  baseUrl: string;
};

export const BOORU_PRESETS: BooruPreset[] = [
  { key: 'E621', name: 'e621', engine: 'e621', baseUrl: 'https://e621.net' },
  { key: 'E926', name: 'e926', engine: 'e621', baseUrl: 'https://e926.net' },
  {
    key: 'DANBOORU',
    name: 'Danbooru',
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us'
  },
  {
    key: 'GELBOORU',
    name: 'Gelbooru',
    engine: 'gelbooru',
    baseUrl: 'https://gelbooru.com'
  },
  {
    key: 'RULE34',
    name: 'Rule34',
    engine: 'gelbooru',
    baseUrl: 'https://rule34.xxx'
  },
  {
    key: 'YANDERE',
    name: 'yande.re',
    engine: 'moebooru',
    baseUrl: 'https://yande.re'
  },
  {
    key: 'KONACHAN',
    name: 'Konachan',
    engine: 'moebooru',
    baseUrl: 'https://konachan.com'
  },
  {
    key: 'SANKAKU',
    name: 'Sankaku Channel',
    engine: 'sankaku',
    baseUrl: 'https://chan.sankakucomplex.com'
  },
  {
    key: 'IDOL_COMPLEX',
    name: 'Idol Complex',
    engine: 'sankaku',
    baseUrl: 'https://idol.sankakucomplex.com'
  },
  {
    key: 'DERPIBOORU',
    name: 'Derpibooru',
    engine: 'philomena',
    baseUrl: 'https://derpibooru.org'
  }
];

export const findPresetByKey = (key: string): BooruPreset | null =>
  BOORU_PRESETS.find((preset) => preset.key === key) ?? null;
