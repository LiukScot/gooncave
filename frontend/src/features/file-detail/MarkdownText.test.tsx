// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { MarkdownText } from './MarkdownText';

const html = (text: string) => renderToStaticMarkup(<MarkdownText text={text} />);

it('renders nested emphasis', () => {
  expect(html('**__Fenneko__** and *friends*, ~~gone~~')).toBe(
    '<strong><u>Fenneko</u></strong> and <em>friends</em>, <s>gone</s>\n'
  );
});

it('renders labelled and bare links, to http(s) only', () => {
  const out = html('[Patreon](https://www.patreon.com/x) https://e621.net/posts/1 [trap](javascript:alert(1))');
  expect(out).toContain('href="https://www.patreon.com/x"');
  expect(out).toContain('>Patreon</a>');
  expect(out).toContain('href="https://e621.net/posts/1"');
  expect(out).not.toContain('href="javascript');
  expect(out).toContain('[trap](javascript:alert(1))');
});

it('groups quoted lines into one block quote', () => {
  expect(html('before\n> first\n> second\nafter')).toBe(
    'before\n<blockquote class="file-detail-source-quote">first\nsecond</blockquote>after\n'
  );
});

it('shows markup in a description as text', () => {
  expect(html('<img src=x onerror=alert(1)>')).toBe(
    '&lt;img src=x onerror=alert(1)&gt;\n'
  );
});

it('nests quotes one level for each extra >', () => {
  expect(html('> outer\n>> inner\n> back')).toBe(
    '<blockquote class="file-detail-source-quote">outer\n<blockquote class="file-detail-source-quote">inner</blockquote>back</blockquote>'
  );
});

it('lets emphasis run over lines but not over a blank one', () => {
  expect(html('*one\ntwo*')).toBe('<em>one\ntwo</em>\n');
  expect(html('*one\n\ntwo*')).toBe('*one\n\ntwo*\n');
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('hides a spoiler, links included, until it is clicked', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () =>
    root.render(<MarkdownText text={'a ||see [here](https://e621.net/posts/1)\nand *more*|| b'} />)
  );
  expect(container.textContent).toBe('a Spoiler b\n');
  expect(container.querySelector('a')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(container.textContent).toBe('a see here\nand more b\n');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('https://e621.net/posts/1');
  expect(container.querySelector('button')).toBeNull();
  act(() => root.unmount());
});

it('leaves a lone || as text', () => {
  expect(html('a || b')).toBe('a || b\n');
});
