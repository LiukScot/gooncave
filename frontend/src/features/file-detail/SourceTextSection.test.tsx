// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { SourceTextSection } from './SourceTextSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sources = [
  { siteName: 'e621', sourceUrl: 'https://e621.net/posts/1', title: null, description: 'from e621' },
  { siteName: 'Danbooru', sourceUrl: 'https://danbooru.donmai.us/posts/2', title: null, description: 'from danbooru' }
];

it('shows one icon per source side by side and switches the text on a tap', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SourceTextSection sources={sources} />));

  const picks = Array.from(container.querySelectorAll<HTMLButtonElement>('.file-detail-source-pick'));
  expect(picks.map((button) => button.getAttribute('aria-label'))).toEqual(['e621', 'Danbooru']);
  expect(container.textContent).toContain('from e621');

  await act(async () => picks[1].click());
  expect(container.textContent).toContain('from danbooru');
  expect(picks[1].getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('select')).toBeNull();

  await act(async () => root.unmount());
  container.remove();
});
