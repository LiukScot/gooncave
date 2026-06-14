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

// Query params that carry a credential or session token. Gelbooru-style
// engines require api_key/user_id in the URL itself, so the URL can't avoid
// them — but the URL must never reach a log or an error returned to the client
// with the secret intact (issue #200 finding 1).
const SECRET_QUERY_KEYS = ['api_key', 'pass_hash', 'login', 'token'];

// Replace the value of any secret-bearing query param with `***` in an
// arbitrary string (a bare URL, or an error message that embeds one). Operates
// textually so it also redacts URLs nested inside undici/fetch error messages,
// not just well-formed standalone URLs.
export const redactUrlSecrets = (value: string): string => {
  let redacted = value;
  for (const key of SECRET_QUERY_KEYS) {
    redacted = redacted.replace(
      new RegExp(`([?&]${escapeRegex(key)}=)[^&\\s'"]+`, 'gi'),
      '$1***'
    );
  }
  return redacted;
};
