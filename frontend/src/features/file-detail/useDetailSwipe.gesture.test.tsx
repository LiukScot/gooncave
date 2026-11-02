// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useDetailSwipe } from './useDetailSwipe';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function Frame() {
  const swipe = useDetailSwipe({
    open: true,
    itemKey: 'post',
    canPrev: true,
    canNext: true,
    onCommit: vi.fn()
  });
  return (
    <div
      ref={swipe.frameRef}
      id="frame"
      data-offset={swipe.offset}
      onTouchStart={swipe.onTouchStart}
      onTouchEnd={swipe.onTouchEnd}
    >
      <a id="link" href="#post">
        Source
      </a>
    </div>
  );
}

const touch = (target: Element, type: string, clientX: number) =>
  act(() => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { touches: [{ clientX, clientY: 400 }] });
    target.dispatchEvent(event);
  });

it('forgets a gesture whose release an edge swipe swallowed', () => {
  const container = document.body.appendChild(document.createElement('div'));
  act(() => {
    root = createRoot(container);
    root.render(<Frame />);
  });
  const frame = document.querySelector<HTMLElement>('#frame')!;
  const link = document.querySelector('#link')!;
  touch(frame, 'touchstart', 4);
  // No touchend: the edge swipe stopped it at the document. A link keeps its own drag.
  touch(link, 'touchstart', 200);
  touch(link, 'touchmove', 100);
  expect(frame.dataset.offset).toBe('0');
});
