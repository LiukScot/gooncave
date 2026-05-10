/**
 * Tiny `Set-Cookie` parser shared by the auth tests.
 *
 * Three test files now read cookie attributes (the in-process
 * NODE_ENV=test path, the production-env happy path, and the
 * production-env Secure=true negative case), so this lives here
 * instead of being copy-pasted.
 */
export type CookieFlags = {
  name: string;
  value: string;
  flags: Set<string>;
  sameSite: string | undefined;
};

export const parseSetCookieFlags = (raw: string): CookieFlags => {
  const parts = raw.split(';').map((p) => p.trim());
  const [namePair, ...flagParts] = parts;
  const [name, value] = namePair.split('=');
  const flags = new Set(flagParts.map((f) => f.toLowerCase().split('=')[0]));
  const sameSite = flagParts
    .map((f) => f.toLowerCase())
    .find((f) => f.startsWith('samesite='))
    ?.split('=')[1];
  return { name, value, flags, sameSite };
};

export const getRawSetCookie = (header: string | string[] | undefined): string => {
  if (!header) throw new Error('expected Set-Cookie header');
  return Array.isArray(header) ? header[0] : header;
};
