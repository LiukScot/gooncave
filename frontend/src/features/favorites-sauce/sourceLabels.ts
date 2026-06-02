import type { BooruSite, SauceSource } from '@/api';

export const resolveSauceSourceLabel = (
  source: Pick<SauceSource, 'key' | 'label'>,
  siteNameById: Readonly<Record<string, string>>
): string => siteNameById[source.key] ?? source.label ?? source.key;

export const mapSauceSourcesWithSiteNames = (
  sources: readonly SauceSource[],
  booruSites: readonly BooruSite[]
): SauceSource[] => {
  const siteNameById = Object.fromEntries(
    booruSites.map((site) => [site.id, site.name])
  );
  return sources.map((source) => ({
    ...source,
    label: resolveSauceSourceLabel(source, siteNameById)
  }));
};
