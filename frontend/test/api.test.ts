import { describe, expect, it } from 'vitest';

import { extractErrorMessage } from '../src/api';

describe('extractErrorMessage', () => {
  it('extracts `error` field from JSON body', () => {
    const text = JSON.stringify({ error: 'Username already exists' });
    expect(extractErrorMessage(text, 'fallback')).toBe('Username already exists');
  });

  it('prefers first zod issue message over `error`', () => {
    const text = JSON.stringify({
      error: 'Invalid payload',
      issues: [{ message: 'Username must be at least 3 characters' }]
    });
    expect(extractErrorMessage(text, 'fallback')).toBe('Username must be at least 3 characters');
  });

  it('falls back to raw text on non-JSON body', () => {
    expect(extractErrorMessage('Internal Server Error', 'fallback')).toBe('Internal Server Error');
  });

  it('uses fallback when body is empty', () => {
    expect(extractErrorMessage('', 'Unknown error')).toBe('Unknown error');
  });

  it('uses fallback when JSON has no error/issues', () => {
    expect(extractErrorMessage('{}', 'fallback')).toBe('{}');
  });
});
