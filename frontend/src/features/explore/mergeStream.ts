import type { ExplorePost, ExploreSort } from '@/api';

export type MergeSort = Exclude<ExploreSort, 'subscribed'>;

/**
 * Where one site has got to in the merged stream.
 *
 * New and Score use provider-ordered pages. Their tails are held until they
 * cannot outrank a page another site has yet to send. Hot uses page cohorts.
 */
export type SiteStream = {
  /** Fetched, ordered, not shown yet. */
  buffer: RankedPost[];
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

export type RankedPost = { post: ExplorePost; rank: number };

export const pageLimitForMerge = (
  sort: MergeSort,
  target: number,
  siteCount: number
): number =>
  sort === 'new'
    ? Math.max(1, Math.ceil(target / Math.max(1, siteCount)))
    : target;

/**
 * The number the sort actually compares. Higher sorts first.
 * New follows each site's own ordering. Its position in that site's list
 * lets the sites alternate.
 */
const rankPage = (
  posts: ExplorePost[],
  sort: MergeSort,
  offset: number
): RankedPost[] =>
  posts.map((post, index) => {
    if (sort === 'new') {
      return { post, rank: -(offset + index) };
    }
    return { post, rank: post.score ?? 0 };
  });

// Array sort is stable, so equal ranks keep the order the sites were visited.
const byRankDesc = (a: RankedPost, b: RankedPost) => b.rank - a.rank;

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
  const ordered = rankPage(
    input.posts,
    input.sort,
    (input.page - 1) * input.limit
  ).sort(byRankDesc);
  const tail = ordered[ordered.length - 1];
  const next = new Map(streams);
  next.set(input.siteId, {
    buffer: [
      ...previous.buffer,
      ...ordered.filter((entry) => input.keep(entry.post))
    ],
    page: input.page,
    lastRank: tail ? tail.rank : previous.lastRank,
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
  streams: Map<string, SiteStream>
): { posts: ExplorePost[]; streams: Map<string, SiteStream> } => {
  const floor = releaseFloor(streams);
  const ready: RankedPost[] = [];
  const next = new Map<string, SiteStream>();
  for (const [siteId, stream] of streams) {
    const held: RankedPost[] = [];
    for (const entry of stream.buffer) {
      if (entry.rank >= floor) ready.push(entry);
      else held.push(entry);
    }
    next.set(siteId, { ...stream, buffer: held });
  }
  ready.sort(byRankDesc);
  return { posts: ready.map((entry) => entry.post), streams: next };
};

/** Asks one site for one page. Rejecting means the site is out of the merge. */
export type PageFetcher = (
  siteId: string,
  page: number,
  signal: AbortSignal
) => Promise<ExplorePost[]>;

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
  siteTimeoutMs?: number;
};

const DEFAULT_SITE_TIMEOUT_MS = 15_000;

const settlePage = async (
  fetchPage: PageFetcher,
  siteId: string,
  page: number,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<ExplorePost[]> =>
  new Promise((resolve, reject) => {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    const cleanup = () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    };
    const timeout = setTimeout(
      () => {
        controller.abort();
        cleanup();
        reject(new Error('Site request timed out'));
      },
      timeoutMs
    );
    if (parentSignal?.aborted) abortFromParent();
    else
      parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    Promise.resolve()
      .then(() => fetchPage(siteId, page, controller.signal))
      .then(
        (posts) => {
          cleanup();
          resolve(posts);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        }
      );
  });

const emptyResult = (): FillResult => ({
  streams: new Map(),
  posts: [],
  errors: [],
  hasMore: false
});

const HOT_FRESHNESS_DAYS = 7;
const HOT_AGE_WEIGHT = 0.75;
const MS_PER_DAY = 86_400_000;

/** Compares a post's score with its site's candidates, then discounts age. */
export const rankHotCandidates = (
  bySite: Map<string, ExplorePost[]>,
  nowMs: number
): ExplorePost[] => {
  const ranked: RankedPost[] = [];
  for (const posts of bySite.values()) {
    const scores = [...new Set(posts.map((post) => post.score ?? 0))].sort(
      (left, right) => left - right
    );
    for (const post of posts) {
      const scoreIndex = scores.indexOf(post.score ?? 0);
      const relativeScore =
        scores.length > 1
          ? scoreIndex / (scores.length - 1)
          : scores[0] > 0
            ? 0.5
            : 0;
      const postedAt = post.createdAt ? Date.parse(post.createdAt) : NaN;
      const ageDays = Number.isFinite(postedAt)
        ? Math.max(0, nowMs - postedAt) / MS_PER_DAY
        : HOT_FRESHNESS_DAYS;
      const freshnessPenalty =
        Math.min(ageDays / HOT_FRESHNESS_DAYS, 1) * HOT_AGE_WEIGHT;
      ranked.push({ post, rank: relativeScore - freshnessPenalty });
    }
  }
  return ranked.sort(byRankDesc).map(({ post }) => post);
};

const fetchHotRound = async (
  current: Map<string, SiteStream>,
  siteIds: string[],
  options: FillOptions
): Promise<{
  candidates: Map<string, ExplorePost[]>;
  errors: FillResult['errors'];
}> => {
  const settled = await Promise.allSettled(
    siteIds.map((siteId) =>
      settlePage(
        options.fetchPage,
        siteId,
        (current.get(siteId)?.page ?? 0) + 1,
        options.siteTimeoutMs ?? DEFAULT_SITE_TIMEOUT_MS,
        options.signal
      )
    )
  );
  const candidates = new Map<string, ExplorePost[]>();
  const errors: FillResult['errors'] = [];
  if (options.signal?.aborted) return { candidates, errors };
  settled.forEach((result, index) => {
    const siteId = siteIds[index];
    const previous = current.get(siteId)!;
    if (result.status === 'rejected') {
      current.set(siteId, { ...previous, exhausted: true });
      errors.push({ siteId, error: (result.reason as Error).message });
      return;
    }
    current.set(siteId, {
      ...previous,
      page: previous.page + 1,
      exhausted: result.value.length < options.limit
    });
    candidates.set(siteId, result.value.filter(options.keep));
  });
  return { candidates, errors };
};

/** Hot ranks one bounded page per site together, then appends later rounds. */
const fillHotPages = async (
  streams: Map<string, SiteStream>,
  options: FillOptions
): Promise<FillResult> => {
  const current = new Map(streams);
  const posts: ExplorePost[] = [];
  const errors: FillResult['errors'] = [];
  for (
    let round = 0;
    posts.length < options.target && round < options.maxRounds;
    round += 1
  ) {
    const siteIds = [...current]
      .filter(([, stream]) => !stream.exhausted)
      .map(([siteId]) => siteId);
    if (!siteIds.length) break;
    const roundResult = await fetchHotRound(current, siteIds, options);
    if (options.signal?.aborted) break;
    errors.push(...roundResult.errors);
    posts.push(...rankHotCandidates(roundResult.candidates, Date.now()));
  }
  return {
    streams: current,
    posts,
    errors,
    hasMore: [...current.values()].some((stream) => !stream.exhausted)
  };
};

/**
 * Asks the blocking sites for their next page until `target` posts can be shown.
 *
 * Each round asks the sites whose unfetched posts could rank highest, in
 * parallel: fetching anyone else would buffer posts that still cannot be
 * released. Under Score that is one site, bar a tie. Under New every site
 * ties once a round is done.
 */
export const fillPages = async (
  streams: Map<string, SiteStream>,
  options: FillOptions
): Promise<FillResult> => {
  if (options.sort === 'hot') return fillHotPages(streams, options);
  let current = streams;
  const posts: ExplorePost[] = [];
  const errors: FillResult['errors'] = [];
  for (
    let round = 0;
    posts.length < options.target && round < options.maxRounds;
    round += 1
  ) {
    const best = releaseFloor(current);
    const siteIds = [...current]
      .filter(([, stream]) => !stream.exhausted && stream.lastRank === best)
      .map(([siteId]) => siteId);
    if (!siteIds.length) break;
    const pages = siteIds.map((siteId) => (current.get(siteId)?.page ?? 0) + 1);
    const settled = await Promise.allSettled(
      siteIds.map((siteId, index) =>
        settlePage(
          options.fetchPage,
          siteId,
          pages[index],
          options.siteTimeoutMs ?? DEFAULT_SITE_TIMEOUT_MS,
          options.signal
        )
      )
    );
    // An abort is the caller replacing this search, not a site failing.
    if (options.signal?.aborted) break;
    settled.forEach((result, index) => {
      const siteId = siteIds[index];
      if (result.status === 'rejected') {
        current = closeStream(current, siteId);
        errors.push({ siteId, error: (result.reason as Error).message });
        return;
      }
      current = ingestPage(current, {
        siteId,
        page: pages[index],
        posts: result.value,
        limit: options.limit,
        sort: options.sort,
        keep: options.keep
      });
    });
    const released = releaseReady(current);
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
 * For New and Score, nothing can be released until each site has said where
 * its ranking starts. Hot compares each site's recent-page candidates.
 */
export const openStreams = async (
  siteIds: string[],
  options: FillOptions
): Promise<FillResult> => {
  if (options.sort === 'hot') {
    return fillHotPages(
      new Map(siteIds.map((siteId) => [siteId, emptyStream()])),
      options
    );
  }
  const settled = await Promise.allSettled(
    siteIds.map((siteId) =>
      settlePage(
        options.fetchPage,
        siteId,
        1,
        options.siteTimeoutMs ?? DEFAULT_SITE_TIMEOUT_MS,
        options.signal
      )
    )
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
  const released = releaseReady(streams);
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
