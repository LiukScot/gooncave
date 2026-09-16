import { describe, expect, it } from 'vitest';

import {
  blockingSiteId,
  closeStream,
  emptyStream,
  fillPages,
  ingestPage,
  openStreams,
  releaseReady,
  type FillOptions,
  type PageFetcher,
  type SiteStream
} from './mergeStream';

import type { ExplorePost } from '@/api';

const post = (
  siteId: string,
  remoteId: string,
  score: number,
  extra: Partial<ExplorePost> = {}
): ExplorePost =>
  ({
    remoteId,
    score,
    md5: null,
    createdAt: null,
    tags: [],
    siteId,
    ...extra
  }) as ExplorePost;

const ingest = (
  streams: Map<string, SiteStream>,
  siteId: string,
  page: number,
  posts: ExplorePost[],
  limit = 3
) =>
  ingestPage(streams, {
    siteId,
    page,
    posts,
    limit,
    sort: 'popular',
    keep: () => true
  });

const ids = (posts: ExplorePost[]) => posts.map((entry) => entry.remoteId);

describe('releaseReady', () => {
  it('holds back what a lower-ranked site could still outrank', () => {
    let streams = new Map<string, SiteStream>();
    streams = ingest(streams, 'a', 1, [
      post('a', 'a1', 2000),
      post('a', 'a2', 1000),
      post('a', 'a3', 500)
    ]);
    streams = ingest(streams, 'b', 1, [
      post('b', 'b1', 300),
      post('b', 'b2', 120),
      post('b', 'b3', 20)
    ]);

    // Site A stops at 500, so nothing below 500 is safe yet: B's 300 could
    // still be beaten by A's next page.
    const first = releaseReady(streams);
    expect(ids(first.posts)).toEqual(['a1', 'a2', 'a3']);

    // A's second page lands where B was waiting; now B can come through.
    const next = ingest(first.streams, 'a', 2, [
      post('a', 'a4', 499),
      post('a', 'a5', 250),
      post('a', 'a6', 100)
    ]);
    // A now stops at 100, B at 20: everything down to 100 is safe, and the
    // two sites interleave by score instead of by page.
    const second = releaseReady(next);
    expect(ids(second.posts)).toEqual(['a4', 'b1', 'a5', 'b2', 'a6']);
    expect(second.streams.get('b')!.buffer.map((entry) => entry.post.remoteId)).toEqual(['b3']);
  });

  it('releases everything once every site is exhausted', () => {
    let streams = new Map<string, SiteStream>();
    streams = ingest(streams, 'a', 1, [post('a', 'a1', 900)]);
    streams = ingest(streams, 'b', 1, [post('b', 'b1', 10)]);
    const released = releaseReady(streams);
    expect(ids(released.posts)).toEqual(['a1', 'b1']);
  });

  it('shows nothing while a site has not answered yet', () => {
    let streams = new Map<string, SiteStream>([['b', emptyStream()]]);
    streams = ingest(streams, 'a', 1, [post('a', 'a1', 900)]);
    expect(releaseReady(streams).posts).toEqual([]);
    expect(ids(releaseReady(closeStream(streams, 'b')).posts)).toEqual(
      ['a1']
    );
  });

  it('keeps the booru order for the new sort even when dates disagree', () => {
    let streams = new Map<string, SiteStream>();
    streams = ingestPage(streams, {
      siteId: 'a',
      page: 1,
      posts: [
        post('a', 'old', 0, { createdAt: '2026-01-01T00:00:00Z' }),
        post('a', 'recent', 0, { createdAt: '2026-06-01T00:00:00Z' }),
        post('a', 'undated', 0)
      ],
      limit: 3,
      sort: 'new',
      keep: () => true
    });
    const released = releaseReady(closeStream(streams, 'a'));
    expect(ids(released.posts)).toEqual(['old', 'recent', 'undated']);
  });
});

describe('ingestPage', () => {
  it('drops what keep rejects but still reads the page the booru sent', () => {
    const streams = ingestPage(new Map(), {
      siteId: 'a',
      page: 1,
      posts: [post('a', 'a1', 900), post('a', 'a2', 300)],
      limit: 2,
      sort: 'popular',
      keep: (entry) => entry.remoteId !== 'a2'
    });
    const stream = streams.get('a')!;
    expect(stream.buffer.map((entry) => entry.post.remoteId)).toEqual(['a1']);
    // The filtered post still sets where the site's ranking stopped, and a
    // full page still means there is more behind it.
    expect(stream.lastRank).toBe(300);
    expect(stream.exhausted).toBe(false);
  });

  it('marks a short page as the end of the site', () => {
    const streams = ingest(new Map(), 'a', 1, [post('a', 'a1', 900)]);
    expect(streams.get('a')!.exhausted).toBe(true);
    expect(blockingSiteId(streams)).toBeNull();
  });
});

describe('blockingSiteId', () => {
  it('picks the site whose unfetched posts could rank highest', () => {
    let streams = new Map<string, SiteStream>();
    streams = ingest(streams, 'a', 1, [
      post('a', 'a1', 900),
      post('a', 'a2', 800),
      post('a', 'a3', 500)
    ]);
    streams = ingest(streams, 'b', 1, [
      post('b', 'b1', 90),
      post('b', 'b2', 80),
      post('b', 'b3', 50)
    ]);
    expect(blockingSiteId(streams)).toBe('a');
    expect(blockingSiteId(closeStream(streams, 'a'))).toBe('b');
  });
});

/**
 * A stand-in booru: `pages` is what it answers, in order, page 1 first. The
 * calls it received are recorded so a test can assert who was asked, which
 * is the whole point of driving the merge from the blocking site.
 */
const fakeSites = (pages: Record<string, ExplorePost[][]>) => {
  const calls: string[] = [];
  const fetchPage = async (siteId: string, page: number) => {
    calls.push(`${siteId}:${page}`);
    const answer = pages[siteId]?.[page - 1];
    if (!answer) throw new Error(`${siteId} has no page ${page}`);
    return answer;
  };
  return { calls, fetchPage };
};

const options = (
  fetchPage: PageFetcher,
  overrides: Partial<FillOptions> = {}
): FillOptions => ({
  sort: 'popular',
  limit: 3,
  target: 6,
  maxRounds: 5,
  keep: () => true,
  fetchPage,
  ...overrides
});

describe('openStreams', () => {
  it('aborts the underlying site request when it times out', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchPage: PageFetcher = (_siteId, _page, signal) => {
      requestSignal = signal;
      return new Promise(() => undefined);
    };

    await openStreams(
      ['stuck'],
      options(fetchPage, { siteTimeoutMs: 5 })
    );

    expect(requestSignal?.aborted).toBe(true);
  });

  it('releases healthy sites when another site never answers', async () => {
    const fetchPage: PageFetcher = (siteId) =>
      siteId === 'stuck'
        ? new Promise(() => undefined)
        : Promise.resolve([post('healthy', 'ready', 10)]);

    const result = await openStreams(
      ['stuck', 'healthy'],
      options(fetchPage, { siteTimeoutMs: 5 })
    );

    expect(ids(result.posts)).toEqual(['ready']);
    expect(result.errors).toEqual([
      { siteId: 'stuck', error: 'Site request timed out' }
    ]);
  });

  it('interleaves sites by score across pages, not by page', async () => {
    const { calls, fetchPage } = fakeSites({
      a: [
        [post('a', 'a1', 2000), post('a', 'a2', 1000), post('a', 'a3', 500)],
        [post('a', 'a4', 499), post('a', 'a5', 250), post('a', 'a6', 100)]
      ],
      b: [[post('b', 'b1', 300), post('b', 'b2', 120), post('b', 'b3', 20)]]
    });
    const result = await openStreams(['a', 'b'], options(fetchPage));

    // A's page 2 stops at 100, so everything down to 100 is safe: B's 300
    // lands between A's 499 and 250 instead of after A's whole first page.
    expect(ids(result.posts)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'b1',
      'a5',
      'b2',
      'a6'
    ]);
    // Only A is asked for more: B's page 2 could not have been shown yet.
    expect(calls).toEqual(['a:1', 'b:1', 'a:2']);
    expect(result.hasMore).toBe(true);
  });

  it('keeps going when a site fails, and reports it', async () => {
    const { fetchPage } = fakeSites({
      a: [[post('a', 'a1', 900)]],
      b: []
    });
    const result = await openStreams(['a', 'b'], options(fetchPage));

    expect(ids(result.posts)).toEqual(['a1']);
    expect(result.errors).toEqual([{ siteId: 'b', error: 'b has no page 1' }]);
    // Both sites are done — the failed one must not hold the merge open.
    expect(result.hasMore).toBe(false);
  });

  it('drops what keep rejects without ending the list early', async () => {
    const { fetchPage } = fakeSites({
      a: [
        [post('a', 'a1', 900), post('a', 'a2', 800), post('a', 'a3', 700)],
        [post('a', 'a4', 600)]
      ]
    });
    const result = await openStreams(
      ['a'],
      options(fetchPage, { keep: (entry) => entry.remoteId !== 'a2' })
    );

    expect(ids(result.posts)).toEqual(['a1', 'a3', 'a4']);
  });
});

describe('fillPages', () => {
  it('stops at the round cap instead of fetching forever', async () => {
    // Two sites a point apart free one post per round: the cap is what keeps
    // a Load more from turning into an unbounded run of requests.
    const page = (siteId: string, n: number) => [
      post(siteId, `${siteId}${n}`, 1000 - n * 2)
    ];
    const { calls, fetchPage } = fakeSites({
      a: Array.from({ length: 20 }, (_, n) => page('a', n * 2)),
      b: Array.from({ length: 20 }, (_, n) => page('b', n * 2 + 1))
    });
    const opened = await openStreams(
      ['a', 'b'],
      options(fetchPage, { limit: 1, target: 100, maxRounds: 2 })
    );
    const before = calls.length;

    const more = await fillPages(
      opened.streams,
      options(fetchPage, { limit: 1, target: 100, maxRounds: 3 })
    );

    expect(calls.length - before).toBe(3);
    expect(more.hasMore).toBe(true);
  });

  it('shows nothing more once every site is exhausted', async () => {
    const { fetchPage } = fakeSites({ a: [[post('a', 'a1', 900)]] });
    const opened = await openStreams(['a'], options(fetchPage));
    const more = await fillPages(opened.streams, options(fetchPage));

    expect(more.posts).toEqual([]);
    expect(more.hasMore).toBe(false);
  });

  it('abandons a search the caller has aborted', async () => {
    const controller = new AbortController();
    const { fetchPage } = fakeSites({
      a: [[post('a', 'a1', 900), post('a', 'a2', 800), post('a', 'a3', 700)]]
    });
    const aborting: PageFetcher = async (siteId, page) => {
      controller.abort();
      return fetchPage(siteId, page);
    };
    const result = await openStreams(
      ['a'],
      options(aborting, { signal: controller.signal })
    );

    expect(result.posts).toEqual([]);
    expect(result.hasMore).toBe(false);
  });
});

describe.each(['hot', 'new'] as const)('%s sort', (sort) => {
  it("keeps each site's own order across pages and alternates the sites", async () => {
    // Hot pages are ranked by the booru's own hotness, not by score: a page
    // mixes high and low scores, and page 2 can open higher than page 1 ends.
    const { calls, fetchPage } = fakeSites({
      a: [
        [post('a', 'a1', 300), post('a', 'a2', 2000), post('a', 'a3', 50)],
        [post('a', 'a4', 1500), post('a', 'a5', 10), post('a', 'a6', 900)]
      ],
      b: [
        [post('b', 'b1', 5), post('b', 'b2', 800), post('b', 'b3', 40)],
        [post('b', 'b4', 700), post('b', 'b5', 1), post('b', 'b6', 3)]
      ]
    });
    const siteOrder = options(fetchPage, { sort });

    const opened = await openStreams(['a', 'b'], siteOrder);
    const more = await fillPages(opened.streams, siteOrder);

    expect(ids(opened.posts)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
    expect(ids(more.posts)).toEqual(['a4', 'b4', 'a5', 'b5', 'a6', 'b6']);
    expect(calls).toEqual(['a:1', 'b:1', 'a:2', 'b:2']);
  });

  it('asks every site for its next page in one round', async () => {
    // Alternating means no post can be shown until every site has moved on,
    // so a round that asked one site at a time would show nothing.
    const page = (siteId: string, from: number) =>
      [from, from + 1, from + 2].map((n) => post(siteId, `${siteId}${n}`, 0));
    const { calls, fetchPage } = fakeSites({
      a: [page('a', 1), page('a', 4)],
      b: [page('b', 1), page('b', 4)]
    });
    const opened = await openStreams(
      ['a', 'b'],
      options(fetchPage, { sort: 'hot', target: 1 })
    );

    const more = await fillPages(
      opened.streams,
      options(fetchPage, { sort: 'hot', target: 1, maxRounds: 1 })
    );

    expect(calls).toEqual(['a:1', 'b:1', 'a:2', 'b:2']);
    expect(ids(more.posts)).toEqual(['a4', 'b4', 'a5', 'b5', 'a6', 'b6']);
  });
});
