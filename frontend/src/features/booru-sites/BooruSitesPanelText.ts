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
  iconLabel: string;
};

export const SUGGESTION_PRESETS: SuggestionPreset[] = [
  {
    key: 'E621',
    name: 'e621',
    engine: 'e621',
    baseUrl: 'https://e621.net',
    iconLabel: 'E6'
  },
  {
    key: 'DANBOORU',
    name: 'Danbooru',
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us',
    iconLabel: 'DB'
  },
  {
    key: 'RULE34',
    name: 'Rule34',
    engine: 'gelbooru',
    baseUrl: 'https://rule34.xxx',
    iconLabel: 'R34'
  }
];

export const SITE_SETTING_LABELS: Record<SiteSettingKey, string> = {
  siteAutoSyncMidnight: 'Daily midnight sync',
  siteReverseSyncEnabled: 'Delete locally also unfavorites remotely',
  siteAutoFavEnabled: 'Auto-favorite source matches'
};

export const SITE_SETTING_HELP_TEXT: Record<SiteSettingKey, string> = {
  siteAutoSyncMidnight:
    'Every night at midnight, sync favorites with this site automatically, so you never have to press Sync yourself.',
  siteReverseSyncEnabled:
    'When you delete a file in the app, also remove it from your favorites on this site.',
  siteAutoFavEnabled:
    'When the scanner finds one of your files on this site, automatically add that post to your favorites there.'
};
