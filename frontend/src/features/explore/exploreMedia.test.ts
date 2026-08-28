import { describe, expect, it } from 'vitest';

import { displayUrlFor, isVideoUrl } from './exploreMedia';

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

describe('displayUrlFor', () => {
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
  });
});
