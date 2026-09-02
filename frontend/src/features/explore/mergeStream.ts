import type { ExplorePost, ExploreSort } from '@/api';

export type MergeSort = Exclude<ExploreSort, 'subscribed'>;

/**
 * Where one site has got to in the merged stream.
 *
 * Every booru answers a page already ordered by the active sort, but the
 * pages of different boorus interleave: e621's second page can outrank
 * danbooru's first. Holding the unshown tail here is what lets the merge
 * release a post only once no site can still produce a better one.
 */
export type SiteStream = {
  /** Fetched, ordered, not shown yet. */
  buffer: ExplorePost[];
  /** Highest page number already requested. */
  page: number;
  /**
   * Rank of the last post this site sent, shown or not. Everything it has
   * left ranks at or below this. `Infinity` before its first page: a site
   * that has never answered could still be holding the top post.
   */
  lastRank: number;
  /** The site answered short, so it has nothing left to give. */
  exhausted: boolean;
};

export const emptyStream = (): SiteStream => ({
  buffer: [],
  page: 0,
  lastRank: Number.POSITIVE_INFINITY,
  exhausted: false
});

/**
 * The number the sort actually compares. Higher sorts first, so an unknown
 * date sinks to the bottom rather than claiming to be the oldest post.
 */
export const postRank = (post: ExplorePost, sort: MergeSort): number => {
  if (sort !== 'new') return post.score ?? 0;
  const parsed = post.createdAt ? Date.parse(post.createdAt) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

const byRankDesc =
  (sort: MergeSort) => (a: ExplorePost, b: ExplorePost) =>
    postRank(b, sort) - postRank(a, sort);

/**
 * The rank a buffered post has to reach to be shown: the best rank any site
 * could still deliver. Everything above it is safe, because no unfetched
 * post can outrank it.
 */
export const releaseFloor = (streams: Map<string, SiteStream>): number => {
  let floor = Number.NEGATIVE_INFINITY;
  for (const stream of streams.values()) {
    if (!stream.exhausted) floor = Math.max(floor, stream.lastRank);
  }
  return floor;
};

/**
 * The site to ask next: the one whose unfetched posts could outrank
 * everything currently held back. `null` once every site is exhausted.
 */
export const blockingSiteId = (
  streams: Map<string, SiteStream>
): string | null => {
  let blocking: string | null = null;
  let best = Number.NEGATIVE_INFINITY;
  for (const [siteId, stream] of streams) {
    if (stream.exhausted) continue;
    if (blocking === null || stream.lastRank > best) {
      blocking = siteId;
      best = stream.lastRank;
    }
  }
  return blocking;
};

/**
 * Records one site's page.
 *
 * `posts` is the raw page: `lastRank` and exhaustion read the page the booru
 * actually sent, while `keep` decides what is worth buffering (duplicates
 * and blacklisted posts are dropped here). A page filtered down to nothing
 * still means the site has more to give.
 */
export const ingestPage = (
  streams: Map<string, SiteStream>,
  input: {
    siteId: string;
    page: number;
    posts: ExplorePost[];
    limit: number;
    sort: MergeSort;
    keep: (post: ExplorePost) => boolean;
  }
): Map<string, SiteStream> => {
  const previous = streams.get(input.siteId) ?? emptyStream();
  const ordered = [...input.posts].sort(byRankDesc(input.sort));
  const tail = ordered[ordered.length - 1];
  const next = new Map(streams);
  next.set(input.siteId, {
    buffer: [...previous.buffer, ...ordered.filter(input.keep)],
    page: input.page,
    lastRank: tail ? postRank(tail, input.sort) : previous.lastRank,
    exhausted: input.posts.length < input.limit
  });
  return next;
};

/** Marks a site that failed or was skipped, so it stops holding the merge. */
export const closeStream = (
  streams: Map<string, SiteStream>,
  siteId: string
): Map<string, SiteStream> => {
  const next = new Map(streams);
  next.set(siteId, { ...(streams.get(siteId) ?? emptyStream()), exhausted: true });
  return next;
};

/**
 * Takes everything that can be shown now, in order, and returns the streams
 * with those posts removed. Appending the result to what is already on
 * screen keeps the whole list ranked without ever reordering it.
 */
export const releaseReady = (
  streams: Map<string, SiteStream>,
  sort: MergeSort
): { posts: ExplorePost[]; streams: Map<string, SiteStream> } => {
  const floor = releaseFloor(streams);
  const posts: ExplorePost[] = [];
  const next = new Map<string, SiteStream>();
  for (const [siteId, stream] of streams) {
    const held: ExplorePost[] = [];
    for (const post of stream.buffer) {
      if (postRank(post, sort) >= floor) posts.push(post);
      else held.push(post);
    }
    next.set(siteId, { ...stream, buffer: held });
  }
  posts.sort(byRankDesc(sort));
  return { posts, streams: next };
};

/** Asks one site for one page. Rejecting means the site is out of the merge. */
export type PageFetcher = (siteId: string, page: number) => Promise<ExplorePost[]>;

export type FillResult = {
  streams: Map<string, SiteStream>;
  /** Ready to show, in order, to append to what is already on screen. */
  posts: ExplorePost[];
  errors: { siteId: string; error: string }[];
  /** A site can still contribute, so there is a Load more worth offering. */
  hasMore: boolean;
};

export type FillOptions = {
  sort: MergeSort;
  /** Page size asked of each site; a shorter answer means the site is done. */
  limit: number;
  /** Stop once this many posts have been released. */
  target: number;
  /** Request cap, so two near-tied sites cannot trickle one post per click. */
  maxRounds: number;
  keep: (post: ExplorePost) => boolean;
  fetchPage: PageFetcher;
  signal?: AbortSignal;
};

const emptyResult = (): FillResult => ({
  streams: new Map(),
  posts: [],
  errors: [],
  hasMore: false
});

/**
 * Asks the blocking site for its next page until `target` posts can be shown.
 *
 * One request per round, always to the site whose unfetched posts could rank
 * highest: fetching anyone else would buffer posts that still cannot be
 * released.
 */
export const fillPages = async (
  streams: Map<string, SiteStream>,
  options: FillOptions
): Promise<FillResult> => {
  let current = streams;
  const posts: ExplorePost[] = [];
  const errors: FillResult['errors'] = [];
  for (
    let round = 0;
    posts.length < options.target && round < options.maxRounds;
    round += 1
  ) {
    const siteId = blockingSiteId(current);
    if (!siteId) break;
    const page = (current.get(siteId)?.page ?? 0) + 1;
    try {
      const fetched = await options.fetchPage(siteId, page);
      if (options.signal?.aborted) break;
      current = ingestPage(current, {
        siteId,
        page,
        posts: fetched,
        limit: options.limit,
        sort: options.sort,
        keep: options.keep
      });
    } catch (err) {
      // An abort is the caller replacing this search, not a site failing.
      if (options.signal?.aborted) break;
      current = closeStream(current, siteId);
      errors.push({ siteId, error: (err as Error).message });
    }
    const released = releaseReady(current, options.sort);
    current = released.streams;
    posts.push(...released.posts);
  }
  return {
    streams: current,
    posts,
    errors,
    hasMore: blockingSiteId(current) !== null
  };
};

/**
 * Starts a search: every site's first page at once, then the same fill loop.
 *
 * Parallel here and sequential after, because nothing can be released until
 * each site has said where its ranking starts — but once they have, only the
 * blocking one is worth asking.
 */
export const openStreams = async (
  siteIds: string[],
  options: FillOptions
): Promise<FillResult> => {
  const settled = await Promise.allSettled(
    siteIds.map((siteId) => options.fetchPage(siteId, 1))
  );
  if (options.signal?.aborted) return emptyResult();
  let streams = new Map<string, SiteStream>();
  const errors: FillResult['errors'] = [];
  settled.forEach((result, index) => {
    const siteId = siteIds[index];
    if (result.status === 'rejected') {
      streams = closeStream(streams, siteId);
      errors.push({ siteId, error: (result.reason as Error).message });
      return;
    }
    streams = ingestPage(streams, {
      siteId,
      page: 1,
      posts: result.value,
      limit: options.limit,
      sort: options.sort,
      keep: options.keep
    });
  });
  const released = releaseReady(streams, options.sort);
  const filled = await fillPages(released.streams, {
    ...options,
    target: options.target - released.posts.length
  });
  return {
    streams: filled.streams,
    posts: [...released.posts, ...filled.posts],
    errors: [...errors, ...filled.errors],
    hasMore: filled.hasMore
  };
};
