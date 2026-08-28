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
