import { describe, expect, it } from 'vitest';

import { ensureHttps } from '../src/urlUtils';

describe('ensureHttps', () => {
  it('returns empty string unchanged', () => {
    expect(ensureHttps('')).toBe('');
  });

  it('returns whitespace-only as empty string', () => {
    expect(ensureHttps('   ')).toBe('');
  });

  it('leaves https:// URLs unchanged', () => {
    expect(ensureHttps('https://gelbooru.com')).toBe('https://gelbooru.com');
  });

  it('leaves http:// URLs unchanged', () => {
    expect(ensureHttps('http://gelbooru.com')).toBe('http://gelbooru.com');
  });

  it('prepends https:// when no scheme present', () => {
    expect(ensureHttps('gelbooru.com')).toBe('https://gelbooru.com');
  });

  it('trims whitespace before checking scheme', () => {
    expect(ensureHttps('  gelbooru.com  ')).toBe('https://gelbooru.com');
  });
});
