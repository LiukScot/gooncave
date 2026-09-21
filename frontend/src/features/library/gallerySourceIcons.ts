import type { BooruSite, DuplicateFile, FileItem } from '@/api';
import { canonicalizeSourceKey, providerScoreThresholds, resolveProviderScore } from '@/features/file-detail/sections';

export type GallerySourceIcon = {
  key: string;
  label: string;
  iconUrl: string | null;
};

const iconFromUrl = (value: string): GallerySourceIcon | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const key = canonicalizeSourceKey(host);
    const faviconHost = key === 'e621' ? 'e621.net' : key === 'danbooru' ? 'danbooru.donmai.us' : url.host;
    const iconUrl = host === 'bsky.app'
      ? 'https://web-cdn.bsky.app/static/favicon-32x32.png'
      : `https://${faviconHost}/favicon.ico`;
    return { key, label: host, iconUrl };
  } catch {
    return null;
  }
};

export function gallerySourceIconForSite(
  site: Pick<BooruSite, 'id' | 'name' | 'presetKey' | 'baseUrl'>
): GallerySourceIcon {
  const icon = iconFromUrl(site.baseUrl);
  return icon
    ? { ...icon, label: site.name }
    : {
        key: `provider:${site.presetKey ?? site.id}`,
        label: site.name,
        iconUrl: null
      };
}

/** One badge per distinct site; a local fallback only when none are known. */
export function gallerySourceIcons(
  files: readonly (FileItem | DuplicateFile)[],
  sites: readonly BooruSite[]
): GallerySourceIcon[] {
  const icons = new Map<string, GallerySourceIcon>();
  const sitesByKey = new Map(sites.map((site) => [site.presetKey ?? site.id, site]));
  for (const file of files) {
    for (const provider of file.favoriteProviders ?? []) {
      const site = sitesByKey.get(provider);
      const icon = site && iconFromUrl(site.baseUrl);
      if (icon) {
        icons.set(icon.key, { ...icon, label: site.name });
      } else {
        icons.set(`provider:${provider}`, {
          key: `provider:${provider}`, label: site?.name ?? 'Unknown site', iconUrl: null
        });
      }
    }

    for (const run of Object.values(file.providers ?? {})) {
      if (!run || run.status !== 'COMPLETED') continue;
      const results: Array<{ sourceUrl: string | null; score: number | null; distance?: number | null }> =
        run.results?.length ? run.results : [{ sourceUrl: run.sourceUrl, score: run.score }];
      for (const result of results) {
        const score = resolveProviderScore(run.provider, result);
        if (score === null || score < providerScoreThresholds[run.provider] || !result.sourceUrl) continue;
        const icon = iconFromUrl(result.sourceUrl);
        if (icon && !icons.has(icon.key)) icons.set(icon.key, icon);
      }
    }
  }
  return icons.size > 0
    ? Array.from(icons.values())
    : [{ key: 'local', label: 'Local copy', iconUrl: null }];
}
