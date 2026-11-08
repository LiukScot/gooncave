// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useEdgeSwipeBack } from './edgeSwipeBack';

const back = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { back, forward: vi.fn() }, subscribe: () => () => undefined })
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  back.mockClear();
});

function Page({ fromAnywhere }: { fromAnywhere: boolean }) {
  useEdgeSwipeBack(() => true, undefined, { fromAnywhere });
  return (
    <div id="page">
      <input id="slider" type="range" aria-label="Volume" />
    </div>
  );
}

const render = (fromAnywhere: boolean) => {
  const container = document.body.appendChild(document.createElement('div'));
  act(() => {
    root = createRoot(container);
    root.render(<Page fromAnywhere={fromAnywhere} />);
  });
};

const touch = (target: Element, type: string, clientX: number) =>
  act(() => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { touches: [{ clientX, clientY: 400 }] });
    target.dispatchEvent(event);
  });

const swipeRight = (target: Element, from: number) => {
  touch(target, 'touchstart', from);
  for (const x of [from + 20, from + 80, from + 200]) touch(target, 'touchmove', x);
  touch(target, 'touchend', from + 200);
};

it('goes back from the middle of a page that allows it', () => {
  render(true);
  swipeRight(document.querySelector('#page')!, 150);
  expect(back).toHaveBeenCalledTimes(1);
});

it('goes back only from the edge of a page that does not', () => {
  render(false);
  swipeRight(document.querySelector('#page')!, 150);
  expect(back).not.toHaveBeenCalled();
  swipeRight(document.querySelector('#page')!, 4);
  expect(back).toHaveBeenCalledTimes(1);
});

it('leaves a sideways drag on a slider to the slider', () => {
  render(true);
  swipeRight(document.querySelector('#slider')!, 150);
  expect(back).not.toHaveBeenCalled();
});
