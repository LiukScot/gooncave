import type { BooruSiteRecord } from '../db/types';

/**
 * The key a site's rows are filed under in `file_tags`, `favorite_items` and
 * `file_post_relations`: the preset key where the site is one of the built-in
 * presets, and its own id otherwise. Stable across renames and base-URL edits,
 * which a name or a URL would not be.
 */
export const siteKey = (site: BooruSiteRecord): string =>
  site.presetKey ?? site.id;
