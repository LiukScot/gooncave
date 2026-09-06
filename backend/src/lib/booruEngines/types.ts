import type { BooruEngineType, BooruSiteRecord } from '../../db/types';

export type TagResult = {
  tag: string;
  category: string;
  score?: number | null;
  sourceUrl?: string | null;
};

export type BooruRemoteFavorite = {
  provider: string;
  remoteId: string;
  sourceUrl: string;
  fileUrl: string | null;
};

export type ExploreSort = 'new' | 'hot' | 'popular';
/**
 * Scales e621 itself offers on its popular page. No 'year': e621 ignores it
 * and silently answers with the day's posts, so offering it would lie.
 */
export type PopularWindow = 'day' | 'week' | 'month';

export type SearchPostsOptions = {
  tags: string[];
  sort: ExploreSort;
  /** Only meaningful when sort is 'popular'. */
  window: PopularWindow;
  /**
   * Any date inside the period to show, as YYYY-MM-DD. The engines widen it
   * to the whole calendar day, week or month, so paging back a week lands on
   * the previous week rather than on a sliding seven-day span.
   */
  date: string;
  /** 1-based. */
  page: number;
  limit: number;
};

export type RemotePost = {
  remoteId: string;
  /** Small thumbnail for the grid. */
  previewUrl: string | null;
  /** Mid-size preview for the detail overlay; falls back to fileUrl. */
  sampleUrl: string | null;
  /** Full-resolution file, used for favorite-download. */
  fileUrl: string | null;
  width: number | null;
  height: number | null;
  score: number | null;
  rating: string | null;
  md5: string | null;
  /** ISO timestamp; null when the engine does not expose it. */
  createdAt: string | null;
  /**
   * Tags with the category the booru filed them under, so the detail view can
   * group them the way the gallery groups a local file's tags. Engines with
   * no category information report everything as 'general'.
   */
  tags: TagResult[];
  /** Times the post was favourited, where the engine reports it. */
  favCount: number | null;
  /** Account that uploaded the post, where the engine reports it. */
  uploader: string | null;
  /** File extension without the dot ('webm', 'png'), for the info list. */
  fileExt: string | null;
  /** File size in bytes, where the engine reports it. */
  fileSize: number | null;
  /**
   * Whether the signed-in account has this post in its remote favorites.
   * `null` when the booru does not say — the caller then falls back to what
   * the local library knows.
   */
  favorited: boolean | null;
  /**
   * The vote the signed-in account already cast: 1, -1, or 0 for none.
   * `null` when the booru does not report it, and the button then shows no
   * colour rather than claiming the post was never voted on.
   */
  voted: 1 | -1 | 0 | null;
  /** Post this one was uploaded as a variant of; null when it is not a child. */
  parentId: string | null;
  /** Whether other posts name this one as their parent. */
  hasChildren: boolean;
  /**
   * Pools this post is a page of. `null` where the listing does not say —
   * which is every engine but e621, and is not the same answer as `[]`:
   * an empty list means the booru said "none", and null means "ask".
   */
  poolIds: string[] | null;
};

/** An ordered set of posts: a comic, a scene, a scanned book. */
export type PoolRecord = {
  id: string;
  /** As the booru stores it, underscores and all. */
  name: string;
  postCount: number;
  /** Every page, in reading order. */
  postIds: string[];
};

/** What a booru says about one post's place in a parent/child group. */
export type PostRelations = {
  parentId: string | null;
  hasChildren: boolean;
  /** Same meaning as on RemotePost: null when the listing never says. */
  poolIds: string[] | null;
};

export type CredentialSchema =
  'username+apikey' | 'userid+apikey' | 'apikey-only' | 'token' | 'none';

export type EngineCapabilityDefaults = {
  favorites: boolean;
  tags: boolean;
  sourceMatch: boolean;
  search: boolean;
  vote: boolean;
};

export type FetchFavoritesContext = {
  onPage?: (page: number, count: number) => void;
  signal?: AbortSignal;
};

export type ProbeSample = {
  postId: string;
  thumbUrl: string | null;
  /** path joined with the user's `base_url` at call time, NOT an absolute URL. */
  postPath: string;
};

export type BooruEngineModule = {
  type: BooruEngineType;
  credentialSchema: CredentialSchema;
  defaultCapabilities: EngineCapabilityDefaults;

  /**
   * Whether the engine accepts an optional session cookie for authenticated
   * actions. Gelbooru-style sites redirect their API-key delete endpoint
   * without proving removal (issue #144), so a browser cookie is needed for
   * reliable reverse-delete. The UI shows a cookie field only when this is set.
   */
  supportsSessionCookie?: boolean;

  /**
   * Whether the engine reports parent/child posts and its search understands
   * the `parent:` and `id:` metatags, which is how a post's relatives are
   * listed. Engines with no parent/child concept (philomena, shimmie,
   * szurubooru) leave it unset and always report no relations.
   */
  supportsRelations?: boolean;

  /**
   * Whether `hasChildren` on a search result can be believed. Gelbooru-style
   * APIs report `parent_id` and nothing else, so on them a parent post looks
   * childless and the only way to know is a `parent:<id>` search. Sankaku is
   * left out too: its API has never been observed reporting the flag.
   */
  reportsHasChildren?: boolean;

  /**
   * Whether the engine has pools — ordered sets of posts — and exposes them
   * over its API. Gelbooru-style sites have pools in their web UI only, so
   * they leave this unset and the pool sections never appear.
   */
  supportsPools?: boolean;

  /** Default UA used for outgoing HTTP if site config doesn't override */
  defaultUserAgent: string;

  /** Returns probe relative path (joined with base_url). */
  probePath: string;
  probeMatches(body: unknown): boolean;
  /**
   * After `probeMatches(body) === true`, pull a single sample post out of
   * the body so the UI can render a thumbnail as proof-of-life. Returning
   * `null` is OK — detection still succeeds, the UI just shows no preview.
   */
  probeSample?(body: unknown): ProbeSample | null;

  fetchPostTags(site: BooruSiteRecord, postId: string): Promise<TagResult[]>;

  /**
   * The tags *and* the relations of one post, from a single read.
   *
   * A post's own page carries both, so an engine that has this saves the
   * second request `fetchPostTags` followed by a `id:<postId>` search would
   * cost — and that pair runs on every file of a first sync, against sites
   * that rate-limit. Engines without it fall back to the two calls.
   */
  fetchPostDetails?(
    site: BooruSiteRecord,
    postId: string
  ): Promise<{ tags: TagResult[]; relations: PostRelations } | null>;
  fetchPostByMd5?(
    site: BooruSiteRecord,
    md5: string
  ): Promise<{ tags: TagResult[]; sourceUrl: string | null } | null>;

  fetchFavorites?(
    site: BooruSiteRecord,
    ctx?: FetchFavoritesContext
  ): Promise<{
    items: BooruRemoteFavorite[];
    downloadHeaders: Record<string, string>;
  }>;

  favorite?(site: BooruSiteRecord, postId: string): Promise<void>;
  unfavorite?(site: BooruSiteRecord, postId: string): Promise<void>;

  /**
   * Multi-site explore search. Sorts the engine cannot express natively are
   * approximated with the closest available ordering (issue #105).
   * `downloadHeaders` must be usable to fetch the returned fileUrls.
   */
  searchPosts?(
    site: BooruSiteRecord,
    options: SearchPostsOptions
  ): Promise<{ posts: RemotePost[]; downloadHeaders: Record<string, string> }>;

  /**
   * The pools a post is a page of. Only needed where a search result does
   * not already carry them, which is every engine but e621.
   */
  fetchPostPoolIds?(site: BooruSiteRecord, postId: string): Promise<string[]>;

  /**
   * The same question answered with whole pools, for a booru whose pool
   * search returns them in full: one read instead of one per pool. Preferred
   * over `fetchPostPoolIds` when both exist.
   */
  fetchPostPools?(site: BooruSiteRecord, postId: string): Promise<PoolRecord[]>;

  /** One pool with its pages in reading order. `null` when it is gone. */
  fetchPool?(site: BooruSiteRecord, poolId: string): Promise<PoolRecord | null>;

  /** Vote on a post. `score` is 1 (up) or -1 (down). */
  vote?(site: BooruSiteRecord, postId: string, score: 1 | -1): Promise<void>;

  /**
   * Best-effort check that the saved session cookie still authenticates a
   * logged-in session. Only meaningful when supportsSessionCookie is true and a
   * cookie is saved. The result must never echo the cookie value.
   */
  checkSessionCookie?(
    site: BooruSiteRecord
  ): Promise<{ ok: boolean; error?: string }>;

  /** Extracts remote post id from a sauce URL if it belongs to this engine. */
  extractIdFromUrl(
    url: string,
    site: BooruSiteRecord
  ): { remoteId: string } | null;

  /** Canonical URL for a post id on this site. */
  buildPostUrl(site: BooruSiteRecord, postId: string): string;
};

export type EngineRegistry = Record<BooruEngineType, BooruEngineModule>;
