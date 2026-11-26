// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { ExploreVideo } from './ExploreVideo';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

it('a video that cannot load says why, logs the site without the address, and tries again', async () => {
  const logged: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    logged.push((JSON.parse(String(init?.body)) as { message: string }).message);
    return new Response(null, { status: 204 });
  }));
  const container = document.createElement('div');
  root = createRoot(container);
  act(() => root?.render(<ExploreVideo siteName="Example" src="https://cdn.example.test/videos/secret-token/clip.webm" playsInline />));
  const video = container.querySelector('video')!;
  Object.defineProperty(video, 'error', { value: { code: 4 } });
  await act(async () => video.dispatchEvent(new Event('error')));

  expect(container.querySelector('[role="alert"]')?.textContent).toContain('format this device cannot play');
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatch(/^\[developer\] An Explore video on Example did not load: format or address not supported \(webm from cdn\.example\.test/);
  expect(logged[0]).not.toContain('secret-token');

  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!;
  act(() => retry.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('video')).not.toBe(video);
});
