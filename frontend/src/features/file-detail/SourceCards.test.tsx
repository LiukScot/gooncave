import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { SourceCards } from './DetailSections';

const favorite = {
  siteName: 'Rule34',
  sourceUrl: 'https://rule34.xxx/index.php?page=post&s=view&id=123'
};

it('links a saved favorite under Sources without a scan result', () => {
  const html = renderToStaticMarkup(
    <SourceCards
      highlights={[]}
      favoriteSources={[favorite]}
      emptyLabel="No scan results yet."
    />
  );

  expect(html).toContain('Open favorited post on Rule34');
  expect(html).toContain('href="https://rule34.xxx/index.php?page=post&amp;s=view&amp;id=123"');
  expect(html).not.toContain('No scan results yet.');
  expect(html).not.toContain('score n/a');
});

it('shows one link when the favorite and scan point to the same post', () => {
  const html = renderToStaticMarkup(
    <SourceCards
      highlights={[{
        id: 'scan-1',
        provider: 'Fluffle',
        sourceUrl: favorite.sourceUrl,
        sourceName: 'Rule34',
        score: 100,
        distance: 0
      }]}
      favoriteSources={[favorite]}
      emptyLabel="No scan results yet."
    />
  );

  expect(html.match(/href=/g)).toHaveLength(1);
  expect(html).toContain('Open favorited post on Rule34');
  expect(html).not.toContain('Fluffle');
});

it('keeps existing scan cards ahead of a later favorite link', () => {
  const html = renderToStaticMarkup(
    <SourceCards
      highlights={[{
        id: 'scan-1',
        provider: 'Fluffle',
        sourceUrl: 'https://e621.net/posts/456',
        sourceName: 'e621',
        score: 100,
        distance: 0
      }]}
      favoriteSources={[favorite]}
      emptyLabel="No scan results yet."
    />
  );

  expect(html.indexOf('href="https://e621.net/posts/456"')).toBeLessThan(
    html.indexOf('aria-label="Open favorited post on Rule34"')
  );
});
