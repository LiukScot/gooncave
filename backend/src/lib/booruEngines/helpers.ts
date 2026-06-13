export const normalizeTag = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w:()-]+/g, '')
    .toLowerCase();

export const stripTrailingSlash = (url: string): string =>
  url.replace(/\/+$/, '');

export const safeJoin = (base: string, path: string): string => {
  const trimmedBase = stripTrailingSlash(base);
  if (!path.startsWith('/')) return `${trimmedBase}/${path}`;
  return `${trimmedBase}${path}`;
};

export const hostnameOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

export const basicAuthHeader = (username: string, apiKey: string): string =>
  `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`;

export const escapeRegex = (value: string): string =>
  value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
