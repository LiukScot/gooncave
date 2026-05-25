export const ensureHttps = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};
