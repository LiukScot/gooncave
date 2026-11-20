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
  act(() => input.click());
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
  expect(onPick).toHaveBeenCalledWith('wolf rating:s');
});

it('keeps recent searches closed while the box only has focus, as when the search panel opens', () => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(<TagSearchInput value="" onChange={() => undefined} recent={['fox']} placeholder="tags" />)
  );
  const input = host.querySelector('input');
  if (!input) throw new Error('no input');
  act(() => input.focus());
  expect(document.querySelector('[role="option"]')).toBeNull();
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['fox']);
});

it('submits an empty box on Enter instead of running a recent search', () => {
  const onPick = vi.fn();
  const onSubmit = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <TagSearchInput
        value=""
        onChange={() => undefined}
        onPick={onPick}
        onSubmit={onSubmit}
        recent={['wolf rating:s']}
        placeholder="tags"
      />
    )
  );
  const input = host.querySelector('input');
  if (!input) throw new Error('no input');
  act(() => input.focus());
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(onSubmit).toHaveBeenCalled();
  expect(onPick).not.toHaveBeenCalled();
});

it('hides recent searches once the box holds a search', () => {
  render('cat', vi.fn());
  expect(document.querySelector('[aria-label="Recent searches"]')).toBeNull();
});
