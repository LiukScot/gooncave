import type { BooruSite, SourceEntry } from '@/api';

export const canTargetSource = (key: string): boolean => !['wd14', 'manual'].includes(key.trim().toLowerCase());

export const resolveSourceEntryLabel = (
  source: Pick<SourceEntry, 'key' | 'label'>,
  siteNameById: Readonly<Record<string, string>>
): string => siteNameById[source.key] ?? source.label ?? source.key;

/** Selectable origin sources; WD14 is a tagger, not an origin site. */
export const mapSourcesWithSiteNames = (
  sources: readonly SourceEntry[],
  booruSites: readonly BooruSite[]
): SourceEntry[] => {
  const siteNameById: Record<string, string> = Object.fromEntries(
    booruSites.map((site): [string, string] => [site.id, site.name])
  );
  return sources
    .filter((source) => source.key.trim().toLowerCase() !== 'wd14')
    .map((source) => ({
      ...source,
      label: resolveSourceEntryLabel(source, siteNameById)
    }));
};
