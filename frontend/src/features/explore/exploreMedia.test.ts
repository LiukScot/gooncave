import { describe, expect, it } from 'vitest';

import {
  cssImageUrl,
  displayUrlFor,
  gridImageUrlFor,
  isGifUrl,
  isVideoUrl,
  mediaSrc
} from './exploreMedia';

import { API_BASE } from '@/api';
import type { BooruEngineType } from '@/api';

describe('isVideoUrl', () => {
  it('accepts the video containers boorus serve', () => {
    expect(isVideoUrl('https://x.test/a/b.mp4')).toBe(true);
    expect(isVideoUrl('https://x.test/a/b.webm')).toBe(true);
  });

  it('ignores a CDN query string after the extension', () => {
    expect(isVideoUrl('https://x.test/b.mp4?1699999999')).toBe(true);
  });

  it('leaves gifs to the image tag that can animate them', () => {
    expect(isVideoUrl('https://x.test/a.gif')).toBe(false);
  });

  it('is false for stills and for a missing url', () => {
    expect(isVideoUrl('https://x.test/a.png')).toBe(false);
    expect(isVideoUrl(null)).toBe(false);
  });
});

describe('isGifUrl', () => {
  it('recognizes gif files with CDN query strings', () => {
    expect(isGifUrl('https://x.test/a.gif?cache=1')).toBe(true);
    expect(isGifUrl('https://x.test/a.jpg')).toBe(false);
  });
});

describe('displayUrlFor', () => {
  it('uses the original for Rule34 full view and animated GIFs', () => {
    expect(displayUrlFor({
      sourceUrl: 'https://rule34.xxx/index.php?page=post&s=view&id=1',
      sampleUrl: 'https://rule34.xxx/samples/1.jpg',
      fileUrl: 'https://rule34.xxx/images/1.jpg',
      previewUrl: 'https://rule34.xxx/thumbnails/1.jpg'
    })).toBe('https://rule34.xxx/images/1.jpg');
    expect(displayUrlFor({
      sampleUrl: 'https://x.test/still.jpg',
      fileUrl: 'https://x.test/animated.gif',
      previewUrl: null
    })).toBe('https://x.test/animated.gif');
  });
  it('plays the file for video, since the sample is only a still', () => {
    expect(
      displayUrlFor({
        sampleUrl: 'https://x.test/s.jpg',
        fileUrl: 'https://x.test/f.mp4',
        previewUrl: 'https://x.test/p.jpg'
      })
    ).toBe('https://x.test/f.mp4');
  });

  it('prefers the sample for stills, which is sized for viewing', () => {
    expect(
      displayUrlFor({
        sampleUrl: 'https://x.test/s.jpg',
        fileUrl: 'https://x.test/f.png',
        previewUrl: 'https://x.test/p.jpg'
      })
    ).toBe('https://x.test/s.jpg');
  });

  it('falls back down the chain when the better sources are missing', () => {
    expect(
      displayUrlFor({
        sampleUrl: null,
        fileUrl: null,
        previewUrl: 'https://x.test/p.jpg'
      })
    ).toBe('https://x.test/p.jpg');
    expect(displayUrlFor({
      sourceUrl: 'https://rule34.xxx/index.php?page=post&s=view&id=1',
      sampleUrl: 'https://rule34.xxx/samples/1.jpg',
      fileUrl: null,
      previewUrl: 'https://rule34.xxx/thumbnails/1.jpg'
    })).toBe('https://rule34.xxx/samples/1.jpg');
  });
});

describe('gridImageUrlFor', () => {
  const post = (engine: BooruEngineType) => ({
    engine,
    previewUrl: 'https://example.test/thumb.jpg',
    sampleUrl: 'https://example.test/sample.jpg',
    fileUrl: 'https://example.test/original.png'
  });

  it.each(['e621', 'danbooru', 'gelbooru', 'moebooru', 'sankaku'] as const)(
    'uses the sharper still sample for %s grid cards',
    (engine) => {
      expect(gridImageUrlFor(post(engine), false)).toBe(
        'https://example.test/sample.jpg'
      );
    }
  );

  it('keeps the available listing image when no bounded sample exists', () => {
    for (const engine of ['furaffinity', 'philomena', 'shimmie', 'szurubooru'] as const) {
      expect(gridImageUrlFor(post(engine), false)).toBe(
        'https://example.test/thumb.jpg'
      );
    }
  });

  it('uses a still sample for tall tiles but never passes video to an image', () => {
    expect(gridImageUrlFor(post('szurubooru'), true)).toBe(
      'https://example.test/sample.jpg'
    );
    expect(gridImageUrlFor({ ...post('danbooru'), sampleUrl: 'https://example.test/video.mp4' }, false))
      .toBe('https://example.test/thumb.jpg');
  });

  it('uses the original gif so animation remains visible in the grid', () => {
    expect(
      gridImageUrlFor(
        { ...post('e621'), fileUrl: 'https://example.test/animated.gif' },
        false
      )
    ).toBe('https://example.test/animated.gif');
  });

  it('falls back to an available still when the preview is missing', () => {
    expect(gridImageUrlFor({ ...post('furaffinity'), previewUrl: null }, false))
      .toBe('https://example.test/sample.jpg');
  });
});

describe('mediaSrc', () => {
  it('serves a cached preview path from the API', () => {
    expect(mediaSrc('/explore/media?u=x&s=y')).toBe(
      `${API_BASE}/explore/media?u=x&s=y`
    );
  });

  it('leaves a booru url alone', () => {
    expect(mediaSrc('https://x.test/p.jpg')).toBe('https://x.test/p.jpg');
  });
});

describe('cssImageUrl', () => {
  it('keeps an already percent-encoded cached path loadable', () => {
    expect(cssImageUrl('/explore/media?u=https%3A%2F%2Fx.test%2Fp.jpg&s=a')).toBe(
      `url("${API_BASE}/explore/media?u=https%3A%2F%2Fx.test%2Fp.jpg&s=a")`
    );
  });

  it('cannot be closed early by a quote in a booru url', () => {
    expect(cssImageUrl('https://x.test/a"b\\c.jpg')).toBe(
      'url("https://x.test/a%22b%5Cc.jpg")'
    );
  });
});
