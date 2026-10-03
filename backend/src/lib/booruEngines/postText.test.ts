import assert from 'node:assert/strict';

import { test } from 'bun:test';

import { dtextToMarkdown, htmlToMarkdown, htmlToText } from './postText';

const E621 = 'https://e621.net';

test('DText formatting becomes the Markdown subset', () => {
  assert.equal(
    dtextToMarkdown('[b][u]Fenneko[/u][/b] and [i]friends[/i], [s]gone[/s]', E621),
    '**__Fenneko__** and *friends*, ~~gone~~'
  );
});

test('a DText quote becomes quoted lines', () => {
  assert.equal(
    dtextToMarkdown('before\n[quote]\nfirst\nsecond\n[/quote]\nafter', E621),
    'before\n\n> first\n> second\n\nafter'
  );
});

test('DText links keep their label, and site-relative ones gain the host', () => {
  assert.equal(
    dtextToMarkdown(
      '"(6+ Edits)":https://www.patreon.com/someone and "rules":/wiki_pages/rules',
      E621
    ),
    '[(6+ Edits)](https://www.patreon.com/someone) and [rules](https://e621.net/wiki_pages/rules)'
  );
});

test('DText with no Markdown counterpart keeps its words only', () => {
  assert.equal(
    dtextToMarkdown(
      'h2. Notes\n[section,expanded=More]kept[/section] [[wolf|wolves]] [[fox]]',
      E621
    ),
    '**Notes**\nkept wolves fox'
  );
  assert.equal(dtextToMarkdown('  [spoiler][/spoiler] ', E621), null);
  assert.equal(dtextToMarkdown(null, E621), null);
});

test('HTML formatting and links become the Markdown subset', () => {
  assert.equal(
    htmlToMarkdown(
      '<strong>Bold</strong> <em>soft</em> <u>under</u><br />' +
        '<a class="auto_link" href="https://www.furaffinity.net/externalurl/?q=https%3A%2F%2Fwww.patreon.com%2Fsomeone"> Patreon </a> ' +
        '<a href="/user/pat" class="iconusername"><img src="//a.example/pat.gif" alt="pat" /></a> ' +
        '<a href="javascript:alert(1)">trap</a>',
      'https://www.furaffinity.net'
    ),
    '**Bold** *soft* __under__\n[Patreon](https://www.patreon.com/someone) [pat](https://www.furaffinity.net/user/pat) trap'
  );
});

test('script content never survives, in text or Markdown', () => {
  const html = 'safe<script>alert(1)</script> &amp; sound';
  assert.equal(htmlToText(html), 'safe & sound');
  assert.equal(htmlToMarkdown(html, 'https://x.example'), 'safe & sound');
  // Nested so that removing the inner element spells the outer one, and
  // left unclosed.
  for (const tricky of [
    'a<scr<script>x</script>ipt>alert(1)</script>b',
    'a<script>alert(1)'
  ]) {
    assert.ok(!htmlToText(tricky)?.includes('alert'));
    assert.ok(!htmlToMarkdown(tricky, 'https://x.example')?.includes('alert'));
  }
});
