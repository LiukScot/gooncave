const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A random site id that names no site here belongs to a site only another device knew. */
export const resolveSourceLabel = (
  source: string,
  siteNameById: Readonly<Record<string, string>>
): string => siteNameById[source] ?? (SITE_ID.test(source) ? 'Unknown site' : source);

export const resolveTopMatchSourceName = (
  input: {
    sourceKey: string | null;
    sourceName: string | null | undefined;
    provider: string;
  },
  siteNameById: Readonly<Record<string, string>>
): string => {
  const { sourceKey, sourceName, provider } = input;
  if (sourceKey && siteNameById[sourceKey]) return siteNameById[sourceKey];
  const trimmedName = sourceName?.trim();
  if (trimmedName) return trimmedName;
  if (sourceKey) return sourceKey;
  return provider;
};
