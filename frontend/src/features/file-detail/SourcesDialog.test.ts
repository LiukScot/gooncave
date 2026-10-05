import { expect, it } from 'vitest';

import { sourceCards } from './SourcesDialog';

const favorite = {
  siteName: 'Rule34',
  sourceUrl: 'https://rule34.xxx/index.php?page=post&s=view&id=123'
};
const scan = (sourceUrl: string, sourceName: string) => ({
  id: 'scan-1',
  provider: 'Fluffle',
  sourceUrl,
  sourceName,
  score: 100,
  distance: 0
});

it('lists a saved favorite without a scan result', () => {
  expect(sourceCards([], [favorite])).toEqual([
    expect.objectContaining({
      url: favorite.sourceUrl,
      kind: 'Favorited post',
      detail: 'Open post'
    })
  ]);
});

it('shows one card when the favorite and scan point to the same post', () => {
  const cards = sourceCards([scan(favorite.sourceUrl, 'Rule34')], [favorite]);
  expect(cards).toHaveLength(1);
  expect(cards[0].kind).toBe('Favorited post');
});

it('keeps existing scan cards ahead of a later favorite', () => {
  const cards = sourceCards(
    [scan('https://e621.net/posts/456', 'e621')],
    [favorite]
  );
  expect(cards.map((card) => card.url)).toEqual([
    'https://e621.net/posts/456',
    favorite.sourceUrl
  ]);
});
