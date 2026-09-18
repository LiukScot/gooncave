import type { BooruSite, SourceEntry } from '@/api';

export const resolveSourceEntryLabel = (
  source: Pick<SourceEntry, 'key' | 'label'>,
  siteNameById: Readonly<Record<string, string>>
): string => siteNameById[source.key] ?? source.label ?? source.key;

export const mapSourcesWithSiteNames = (
  sources: readonly SourceEntry[],
  booruSites: readonly BooruSite[]
): SourceEntry[] => {
  const siteNameById: Record<string, string> = Object.fromEntries(
    booruSites.map((site): [string, string] => [site.id, site.name])
  );
  return sources.map((source) => ({
    ...source,
    label: resolveSourceEntryLabel(source, siteNameById)
  }));
};
