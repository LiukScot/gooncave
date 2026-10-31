// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import { FoldedBox } from './FoldedBox';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// happy-dom does no layout, so the heights are stated by hand.
const heights = (content: number, cut: number) => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => content
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => cut
  });
};

const mount = () => {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(<FoldedBox maxHeight="10px">text</FoldedBox>));
  return host;
};

afterEach(() => {
  document.body.innerHTML = '';
});

it('folds content taller than the cut and unfolds on demand', () => {
  heights(300, 160);
  const host = mount();
  const button = host.querySelector('button');
  expect(button?.textContent).toBe('Show more');
  act(() => button?.click());
  expect(host.querySelector('button')?.textContent).toBe('Show less');
  expect(host.querySelector('.is-cut')).toBeNull();
});

it('shows no button for content that fits', () => {
  heights(100, 160);
  expect(mount().querySelector('button')).toBeNull();
});
