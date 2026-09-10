import { describe, expect, it } from 'vitest';

import { SUGGESTION_PRESETS } from '../src/features/booru-sites/BooruSitesPanelText';
import {
  FURAFFINITY_COOKIE_HELP,
  FURAFFINITY_WARNING,
  credentialFieldsForSchema
} from '../src/features/booru-sites/shared';

describe('FurAffinity account setup', () => {
  it('offers the canonical FurAffinity site as a suggestion', () => {
    expect(
      SUGGESTION_PRESETS.find((preset) => preset.key === 'FURAFFINITY')
    ).toEqual({
      key: 'FURAFFINITY',
      name: 'FurAffinity',
      engine: 'furaffinity',
      baseUrl: 'https://www.furaffinity.net',
      iconLabel: 'FA'
    });
  });

  it('asks for a username without pretending the cookie is an API key', () => {
    expect(credentialFieldsForSchema('username+session-cookie')).toEqual({
      username: true,
      usernameLabel: 'Username',
      apiKey: false,
      apiKeyLabel: ''
    });
  });

  it('keeps the unofficial integration warning user-visible', () => {
    expect(FURAFFINITY_WARNING).toMatch(/Unofficial FurAffinity integration/);
    expect(FURAFFINITY_WARNING).toMatch(/requests to one per second/);
  });

  it('explains what the session cookie is and how to copy it', () => {
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/two cookies authenticate/i);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/DevTools \(F12\) → Network/);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/host is www\.furaffinity\.net/i);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/right-hand details panel/i);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/Cookies tab/i);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/Request Cookies/i);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/includes both "a" and "b"/i);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/Cookie a field/i);
    expect(FURAFFINITY_COOKIE_HELP).toMatch(/Cookie b field/i);
  });
});
