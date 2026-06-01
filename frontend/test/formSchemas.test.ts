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
      apiKey: '',
      capabilities: {
        capFavorites: false,
        capTags: true,
        capSourceMatch: true
      }
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
          apiKey: '  secret  '
        },
        'gelbooru'
      )
    ).toEqual({
      name: 'My booru',
      engine: 'gelbooru',
      baseUrl: 'https://gelbooru.com/',
      username: 'user',
      apiKey: 'secret',
      enabled: true
    });
  });

  it('keeps credential-row fields optional but trims saved values', () => {
    const result = createBooruCredentialSchema('username+apikey').safeParse({
      username: '  demo  ',
      apiKey: '  token  '
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
});
