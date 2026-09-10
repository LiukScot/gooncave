import type { BooruCredentialSchema, BooruEngineType } from '@/api';

export const FURAFFINITY_WARNING =
  'Unofficial FurAffinity integration. GoonCave uses your session cookie to read and update favorites. FurAffinity does not support this app and may block automated traffic. GoonCave limits requests to one per second and retries temporary failures. Use at your own risk and refresh the cookie if authentication expires.';

export const SESSION_COOKIE_HELP = `Lets remote unfavorite work on Gelbooru-style sites (like rule34.xxx) where the API key alone redirects without actually deleting.

How to get it:
1. Log in to the site in your browser.
2. Open DevTools (F12) → Network tab, reload the page, then click any request to the site.
3. Under Request Headers, copy the whole "Cookie" value and paste it here as-is.

It expires over time; re-paste it if remote delete starts failing.`;

export const FURAFFINITY_COOKIE_HELP = `Two cookies authenticate GoonCave with your FurAffinity session: "a" and "b".

How to get it:
1. Log in to FurAffinity in your browser.
2. Open DevTools (F12) → Network, clear the list, then reload FurAffinity.
3. In the request list, click any row whose host is www.furaffinity.net. A page, script, or CSS row is fine; do not use d.furaffinity.net or t.furaffinity.net.
4. In the right-hand details panel, click the Cookies tab.
5. Open Request Cookies and confirm that it includes both "a" and "b".
6. Copy the value of "a" into the Cookie a field.
7. Copy the value of "b" into the Cookie b field.
8. Copy only the values: do not include "a=", "b=", quotes, or spaces.

It expires over time; re-paste it if authentication fails.`;

export const ENGINE_LABELS: Record<BooruEngineType, string> = {
  danbooru: 'Danbooru',
  e621: 'e621',
  moebooru: 'Moebooru (yande.re / konachan)',
  gelbooru: 'Gelbooru',
  sankaku: 'Sankaku',
  philomena: 'Philomena (Derpibooru)',
  shimmie: 'Shimmie2',
  szurubooru: 'Szurubooru',
  furaffinity: 'FurAffinity'
};

export const credentialFieldsForSchema = (schema: BooruCredentialSchema) => {
  switch (schema) {
    case 'username+apikey':
      return {
        username: true,
        usernameLabel: 'Username',
        apiKey: true,
        apiKeyLabel: 'API key'
      };
    case 'userid+apikey':
      return {
        username: true,
        usernameLabel: 'User ID',
        apiKey: true,
        apiKeyLabel: 'API key'
      };
    case 'username+session-cookie':
      return {
        username: true,
        usernameLabel: 'Username',
        apiKey: false,
        apiKeyLabel: ''
      };
    case 'apikey-only':
      return {
        username: false,
        usernameLabel: '',
        apiKey: true,
        apiKeyLabel: 'API key'
      };
    case 'token':
      return {
        username: false,
        usernameLabel: '',
        apiKey: true,
        apiKeyLabel: 'Token'
      };
    case 'none':
    default:
      return {
        username: false,
        usernameLabel: '',
        apiKey: false,
        apiKeyLabel: ''
      };
  }
};
