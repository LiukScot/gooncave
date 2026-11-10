// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { MAX_PLAYING_TILES, ThumbnailMotion } from './ThumbnailMotion';

import { API_BASE } from '@/api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('plays only a bounded number of GIF tiles at once, and a waiting tile takes a freed place', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
    }
  );
  // Each preview's object URL names the request it came from.
  vi.stubGlobal('fetch', (src: string) => Promise.resolve({ ok: true, blob: () => Promise.resolve({ src }) }));
  vi.spyOn(URL, 'createObjectURL').mockImplementation((preview) => `blob:${(preview as unknown as { src: string }).src}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const tiles = Array.from({ length: MAX_PLAYING_TILES + 3 }, (_, index) => `/thumbnails/tile${index}-motion.jpg`);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (posters: string[], providerGif?: string) =>
    root.render(<>{posters.map((poster) => <ThumbnailMotion key={poster} poster={poster} providerGif={poster === providerGif} />)}</>);

  await act(async () => render(tiles));
  expect(container.querySelectorAll('video')).toHaveLength(MAX_PLAYING_TILES);

  await act(async () => render(tiles.slice(1)));
  const playing = [...container.querySelectorAll('video')].map((video) => video.getAttribute('src'));
  expect(playing).toHaveLength(MAX_PLAYING_TILES);
  expect(playing).toContain(`blob:${API_BASE}${tiles[MAX_PLAYING_TILES]}?motion=1`);

  const providerPoster = '/thumbnails/provider.jpg';
  await act(async () => render([providerPoster, '/thumbnails/still.jpg'], providerPoster));
  expect([...container.querySelectorAll('video')].map((video) => video.getAttribute('src')))
    .toEqual([`blob:${API_BASE}${providerPoster}?motion=1`]);

  await act(async () => root.unmount());
  container.remove();
});
