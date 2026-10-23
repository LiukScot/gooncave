import type { BooruCredentialSchema, BooruEngineType } from '@/api';

export const FURAFFINITY_WARNING =
  'Unofficial FurAffinity integration. GoonCave uses your session to read and update favorites. FurAffinity does not support this app and may block automated traffic. GoonCave limits requests to one per second and retries temporary failures. Use at your own risk and sign in again if the session expires.';

export const SESSION_COOKIE_HELP = `Lets GoonCave add and remove favorites on your account. The API key alone only reads.

How to get it:
1. Log in to the site in a desktop browser.
2. Open DevTools (F12) → Network tab, reload the page, then click any request to the site.
3. Under Request Headers, copy the whole "Cookie" value and paste it here as-is.

It expires over time; paste it again if favorites stop saving. In the GoonCave app, use Sign in instead.`;

export const GELBOORU_KEY_HELP = `Both come from the site's account options page: open the site, log in, then go to My Account → Options (index.php?page=account&s=options).

1. Find the "API Access Credentials" section. It shows a line like &api_key=…&user_id=….
2. If it is empty, tick "Generate New Key?", save, and open the page again.
3. Copy the number after user_id= into User ID.
4. Copy the long code after api_key= into API key.`;

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
