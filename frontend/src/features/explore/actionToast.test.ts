import { describe, expect, it } from 'vitest';

import { readableActionError } from './actionToast';

describe('readableActionError', () => {
  it('explains a status without showing the raw body', () => {
    const error = new Error(
      'Vote removal failed (404): {"success":false,"message":"That record was not found.","backtrace":["a.rb:1"]}'
    );
    expect(readableActionError(error)).toBe(
      'The site no longer has this item. It may have been deleted there.'
    );
  });

  it('covers refused logins, rate limits and site outages', () => {
    expect(readableActionError(new Error('Vote failed (403): {}'))).toMatch(/login/);
    expect(readableActionError(new Error('Vote failed (429): {}'))).toMatch(/limiting/);
    expect(readableActionError(new Error('Vote failed (502): {}'))).toMatch(/problems/);
  });

  it('explains a network failure', () => {
    expect(readableActionError(new TypeError('Failed to fetch'))).toMatch(/connection/);
  });

  it('passes other messages through', () => {
    expect(readableActionError('Tag already exists')).toBe('Tag already exists');
  });
});
