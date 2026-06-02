export const resolveSourceLabel = (
  source: string,
  siteNameById: Readonly<Record<string, string>>
): string => siteNameById[source] ?? source;

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
