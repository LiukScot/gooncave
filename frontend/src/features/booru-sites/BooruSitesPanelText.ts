import type { BooruEngineType } from '@/api';

export type SiteSettingKey =
  | 'siteAutoSyncMidnight'
  | 'siteReverseSyncEnabled'
  | 'siteAutoFavEnabled';

export type SuggestionPreset = {
  key: string;
  name: string;
  engine: BooruEngineType;
  baseUrl: string;
};

export const SUGGESTION_PRESETS: SuggestionPreset[] = [
  {
    key: 'E621',
    name: 'e621',
    engine: 'e621',
    baseUrl: 'https://e621.net'
  },
  {
    key: 'E926',
    name: 'e926',
    engine: 'e621',
    baseUrl: 'https://e926.net'
  },
  {
    key: 'DANBOORU',
    name: 'Danbooru',
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us'
  },
  {
    key: 'RULE34',
    name: 'rule34.xxx',
    engine: 'gelbooru',
    baseUrl: 'https://api.rule34.xxx'
  },
  {
    key: 'FURAFFINITY',
    name: 'FurAffinity',
    engine: 'furaffinity',
    baseUrl: 'https://www.furaffinity.net'
  }
];

export const SITE_SETTING_LABELS: Record<SiteSettingKey, string> = {
  siteAutoSyncMidnight: 'Automatic sync',
  siteReverseSyncEnabled: 'Delete locally also unfavorites remotely',
  siteAutoFavEnabled: 'Auto-favorite source matches'
};

export const SITE_SETTING_HELP_TEXT: Record<SiteSettingKey, string> = {
  siteAutoSyncMidnight:
    'While GoonCave runs, new favorites on this site arrive within 15 minutes, with a full check when the app starts and once a day. No need to press Sync yourself.',
  siteReverseSyncEnabled:
    'When you delete a file in the app, also remove it from your favorites on this site.',
  siteAutoFavEnabled:
    'When the scanner finds one of your files on this site, automatically add that post to your favorites there.'
};
