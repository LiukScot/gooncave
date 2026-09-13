// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { RemoteImage } from './RemoteImage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

const render = (src: string) =>
  act(() => {
    root?.render(
      <RemoteImage
        src={src}
        alt="Post 1"
        fallback={<span data-test-id="fallback">no preview</span>}
      />
    );
  });

const failCurrentImage = () => {
  const img = container.querySelector('img');
  expect(img).not.toBeNull();
  act(() => {
    img!.dispatchEvent(new Event('error'));
  });
  return img!;
};

it('loads a failed image again after a delay, in a new element', () => {
  render('https://x.test/p.jpg');
  const first = failCurrentImage();
  expect(first.classList.contains('invisible')).toBe(true);

  act(() => vi.advanceTimersByTime(5_000));

  const second = container.querySelector('img');
  expect(second).not.toBe(first);
  expect(second?.classList.contains('invisible')).toBe(false);
  expect(second?.getAttribute('src')).toBe('https://x.test/p.jpg');
});

it('shows the fallback once every retry has failed', () => {
  render('https://x.test/p.jpg');
  for (const delay of [5_000, 20_000, 60_000]) {
    failCurrentImage();
    act(() => vi.advanceTimersByTime(delay));
  }
  failCurrentImage();
  act(() => vi.advanceTimersByTime(120_000));

  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('[data-test-id="fallback"]')).not.toBeNull();
});

it('starts over for a different image', () => {
  render('https://x.test/a.jpg');
  failCurrentImage();
  render('https://x.test/b.jpg');

  const img = container.querySelector('img');
  expect(img?.getAttribute('src')).toBe('https://x.test/b.jpg');
  expect(img?.classList.contains('invisible')).toBe(false);
});
