// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { OriginalMedia } from './OriginalMedia';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
let failLoad: (() => void) | null = null;

const settle = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error('Expected media state did not appear');
};

const shownAttempt = () => document.querySelector('[data-attempt]')?.getAttribute('data-attempt') ?? null;

function render() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(
    <OriginalMedia fileId="file-1" render={({ key, onError }) => {
      failLoad = onError;
      return <span key={key} data-attempt={key} />;
    }} />
  ));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  failLoad = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

it('says why a file did not open and loads it again on request', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    Response.json({ error: 'Turn on Sync pictures and videos.' }, { status: 503 })));
  render();
  act(() => failLoad!());
  await settle(() => document.querySelector('[role="alert"]') !== null);
  expect(document.body.textContent).toContain('Turn on Sync pictures and videos.');

  act(() => document.querySelector('button')!.click());
  expect(shownAttempt()).toBe('1');
});

it('retries once when the device serves the file, then stops instead of looping', async () => {
  const fetch = vi.fn(async () => new Response('bytes'));
  vi.stubGlobal('fetch', fetch);
  render();
  act(() => failLoad!());
  await settle(() => shownAttempt() === '1');

  act(() => failLoad!());
  await settle(() => document.querySelector('[role="alert"]') !== null);
  expect(document.body.textContent).toContain('cannot show its format');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('tells the core the file was closed so it can drop an original that opening downloaded', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  render();
  expect(fetch).not.toHaveBeenCalled();

  act(() => root!.unmount());
  root = null;
  await settle(() => fetch.mock.calls.length === 1);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('/files/file-1/release');
  expect(init.method).toBe('POST');
});
