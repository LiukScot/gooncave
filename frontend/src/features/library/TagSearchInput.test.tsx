// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/api', () => ({ api: { suggestTags: vi.fn() } }));

import { TagSearchInput } from './TagSearchInput';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const render = (value: string, onPick: (next: string) => void) => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <TagSearchInput
        value={value}
        onChange={() => undefined}
        onPick={onPick}
        recent={['wolf rating:s', 'fox']}
        placeholder="tags"
      />
    )
  );
  const input = host.querySelector('input');
  if (!input) throw new Error('no input');
  act(() => input.focus());
  return input;
};

it('offers recent searches in an empty box and runs the whole search picked with the keyboard', () => {
  const onPick = vi.fn();
  const input = render('', onPick);
  const options = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  expect(options).toEqual(['wolf rating:s', 'fox']);
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(onPick).toHaveBeenCalledWith('fox');
});

it('hides recent searches once the box holds a search', () => {
  render('cat', vi.fn());
  expect(document.querySelector('[aria-label="Recent searches"]')).toBeNull();
});
