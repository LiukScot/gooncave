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
