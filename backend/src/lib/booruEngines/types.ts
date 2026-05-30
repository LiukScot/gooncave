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

export type CredentialSchema =
  | 'username+apikey'
  | 'userid+apikey'
  | 'apikey-only'
  | 'token'
  | 'none';

export type EngineCapabilityDefaults = {
  favorites: boolean;
  tags: boolean;
  sourceMatch: boolean;
  search: boolean;
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
  ): Promise<{ items: BooruRemoteFavorite[]; downloadHeaders: Record<string, string> }>;

  favorite?(site: BooruSiteRecord, postId: string): Promise<void>;
  unfavorite?(site: BooruSiteRecord, postId: string): Promise<void>;

  /** Extracts remote post id from a sauce URL if it belongs to this engine. */
  extractIdFromUrl(url: string, site: BooruSiteRecord): { remoteId: string } | null;

  /** Canonical URL for a post id on this site. */
  buildPostUrl(site: BooruSiteRecord, postId: string): string;
};

export type EngineRegistry = Record<BooruEngineType, BooruEngineModule>;
