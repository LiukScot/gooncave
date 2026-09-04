import { describe, expect, it } from 'vitest';

import {
  GALLERY_MAX_LIMIT,
  GALLERY_PAGE_SIZE,
  resetFetchLimit
} from './galleryPaging';

describe('resetFetchLimit', () => {
  it('asks for one page when nothing is cached', () => {
    expect(resetFetchLimit(0)).toBe(GALLERY_PAGE_SIZE);
  });

  it('asks for one page when the cached list never left the first', () => {
    expect(resetFetchLimit(1)).toBe(GALLERY_PAGE_SIZE);
    expect(resetFetchLimit(GALLERY_PAGE_SIZE)).toBe(GALLERY_PAGE_SIZE);
  });

  it('asks back to the depth the cached list reached', () => {
    expect(resetFetchLimit(GALLERY_PAGE_SIZE + 1)).toBe(GALLERY_PAGE_SIZE + 1);
    expect(resetFetchLimit(600)).toBe(600);
  });

  it('stops at the ceiling the backend enforces', () => {
    expect(resetFetchLimit(GALLERY_MAX_LIMIT + 1)).toBe(GALLERY_MAX_LIMIT);
    expect(resetFetchLimit(50_000)).toBe(GALLERY_MAX_LIMIT);
  });

  it('falls back to one page for a nonsense offset', () => {
    expect(resetFetchLimit(Number.NaN)).toBe(GALLERY_PAGE_SIZE);
    expect(resetFetchLimit(-1)).toBe(GALLERY_PAGE_SIZE);
  });
});
