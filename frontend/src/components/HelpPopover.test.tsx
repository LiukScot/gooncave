// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import { HelpPopover } from './HelpPopover';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it('keeps desktop help inert and shows touch help when clicked', () => {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<HelpPopover text="Tap help" />));

  expect(container.querySelector('.favorites-help-desktop')).toBeInstanceOf(
    HTMLSpanElement
  );
  expect(container.querySelector('.favorites-help-mobile')).toBeInstanceOf(
    HTMLButtonElement
  );

  act(() => container.querySelector('button')?.click());

  expect(document.body.textContent).toContain('Tap help');
  container.remove();
});
