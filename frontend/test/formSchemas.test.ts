import { describe, expect, it } from 'vitest';

import {
  buildAuthFormSchema,
  toAuthSubmitPayload
} from '../src/features/auth/authSchemas';
import {
  booruSiteAddSchema,
  createBooruCredentialSchema,
  toBooruCredentialUpdatePayload,
  toBooruSiteCreatePayload
} from '../src/features/booru-sites/formSchemas';

describe('authSchemas', () => {
  it('rejects invalid register input with backend-matching messages', () => {
    const result = buildAuthFormSchema('register').safeParse({
      username: 'a',
      password: 'short',
      confirmPassword: 'different'
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain('Username must be at least 3 characters');
    expect(messages).toContain('Password must be at least 8 characters');
    expect(messages).toContain('Passwords do not match');
  });

  it('trims auth payloads before submit', () => {
    expect(
      toAuthSubmitPayload({
        username: '  smoke-user  ',
        password: 'Password123',
        confirmPassword: ''
      })
    ).toEqual({
      username: 'smoke-user',
      password: 'Password123'
    });
  });
});

describe('booru form schemas', () => {
  it('rejects add-site input without a valid normalized URL', () => {
    const result = booruSiteAddSchema.safeParse({
      name: '',
      baseUrl: 'not a url',
      username: '',
      apiKey: ''
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    const messages = result.error.issues.map((issue) => issue.message);
    expect(messages).toContain('Name is required');
    expect(messages).toContain('Base URL must be a valid URL');
  });

  it('shapes add-site payloads like the current mutation path', () => {
    expect(
      toBooruSiteCreatePayload(
        {
          name: '  My booru  ',
          baseUrl: 'gelbooru.com/',
          username: '  user  ',
          apiKey: '  secret  ',
          sessionCookie: '',
          cookieA: '',
          cookieB: ''
        },
        'gelbooru'
      )
    ).toEqual({
      name: 'My booru',
      engine: 'gelbooru',
      baseUrl: 'https://gelbooru.com/',
      username: 'user',
      apiKey: 'secret',
      sessionCookie: null,
      enabled: true
    });
  });

  it('keeps credential-row fields optional but trims saved values', () => {
    const result = createBooruCredentialSchema('username+apikey').safeParse({
      username: '  demo  ',
      apiKey: '  token  ',
      cookieA: '',
      cookieB: ''
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(toBooruCredentialUpdatePayload(result.data)).toEqual({
      username: 'demo',
      apiKey: 'token'
    });
  });

  it('omits blank secrets so saving one does not wipe the other', () => {
    const result = createBooruCredentialSchema('userid+apikey').safeParse({
      username: '42',
      apiKey: '',
      sessionCookie: 'user_id=42; pass_hash=abc',
      cookieA: '',
      cookieB: ''
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    const payload = toBooruCredentialUpdatePayload(result.data);
    // Cookie typed, API key left blank → only the cookie is sent; the backend
    // keeps the stored API key because apiKey is absent from the payload.
    expect(payload).toEqual({
      username: '42',
      sessionCookie: 'user_id=42; pass_hash=abc'
    });
    expect('apiKey' in payload).toBe(false);
  });

  it('creates a FurAffinity payload with a write-only session cookie', () => {
    expect(
      toBooruSiteCreatePayload(
        {
          name: 'FurAffinity',
          baseUrl: 'https://www.furaffinity.net',
          username: 'demo',
          apiKey: '',
          sessionCookie: '',
          cookieA: '  account  ',
          cookieB: '  session  '
        },
        'furaffinity'
      )
    ).toEqual({
      name: 'FurAffinity',
      engine: 'furaffinity',
      baseUrl: 'https://www.furaffinity.net',
      username: 'demo',
      apiKey: null,
      sessionCookie: 'a=account; b=session',
      enabled: true
    });
  });

  it('requires FurAffinity cookie a and b together when updating', () => {
    const result = createBooruCredentialSchema(
      'username+session-cookie'
    ).safeParse({
      username: 'demo',
      apiKey: '',
      sessionCookie: '',
      cookieA: 'account',
      cookieB: ''
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        'Cookie a and Cookie b must be entered together'
      );
    }
  });

  it('combines FurAffinity update fields without exposing the storage format', () => {
    const result = createBooruCredentialSchema(
      'username+session-cookie'
    ).safeParse({
      username: 'demo',
      apiKey: '',
      sessionCookie: '',
      cookieA: ' account ',
      cookieB: ' session '
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        toBooruCredentialUpdatePayload(
          result.data,
          'username+session-cookie'
        )
      ).toEqual({
        username: 'demo',
        sessionCookie: 'a=account; b=session'
      });
    }
  });
});
