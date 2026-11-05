// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useGalleryFollowsLibrary } from './useGalleryFollowsLibrary';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const scrollTo = (y: number) => {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
};

const setup = () => {
  const refresh = vi.fn();
  function Probe(props: { version?: number; onGallery: boolean; showing: boolean }) {
    useGalleryFollowsLibrary(props.version, props.onGallery, props.showing, refresh);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (version: number | undefined, { onGallery = true, showing = true } = {}) =>
    act(async () => root.render(<Probe version={version} onGallery={onGallery} showing={showing} />));
  return { refresh, render, unmount: () => act(() => root.unmount()) };
};

afterEach(() => scrollTo(0));

it('refreshes once per change of the library, not for the first value it reads', async () => {
  const { refresh, render, unmount } = setup();
  await render(undefined);
  await render(10);
  expect(refresh).not.toHaveBeenCalled();
  await render(11);
  expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
  await render(11);
  expect(refresh).toHaveBeenCalledTimes(1);
  unmount();
});

it('keeps the place of a reader who scrolled, and shows the new files back at the top', async () => {
  const { refresh, render, unmount } = setup();
  await render(10);
  scrollTo(900);
  await render(11);
  expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
  scrollTo(0);
  await act(async () => window.dispatchEvent(new Event('scroll')));
  expect(refresh).toHaveBeenLastCalledWith(false);
  expect(refresh).toHaveBeenCalledTimes(2);
  unmount();
});

it('keeps the place under an open file, and shows the new files when it closes', async () => {
  const { refresh, render, unmount } = setup();
  await render(10, { showing: false });
  await render(11, { showing: false });
  expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
  await render(11);
  expect(refresh).toHaveBeenLastCalledWith(false);
  unmount();
});

it('does nothing away from the gallery, and does not count that change on return', async () => {
  const { refresh, render, unmount } = setup();
  await render(10);
  await render(11, { onGallery: false });
  await render(12, { onGallery: false });
  await render(13);
  expect(refresh).not.toHaveBeenCalled();
  await render(14);
  expect(refresh).toHaveBeenCalledExactlyOnceWith(false);
  unmount();
});
