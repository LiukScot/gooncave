import { fetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import {
  basicAuthHeader,
  escapeRegex,
  normalizeTag,
  safeJoin,
  toIsoOrNull,
  toNumberOrNull,
  toParentId,
  toPoolRecord
} from './helpers';
import type {
  BooruEngineModule,
  BooruRemoteFavorite,
  RemotePost,
  TagResult
} from './types';
import { dateMetatag, windowRange } from './windowRange';

type E621TagBuckets = {
  general?: string[];
  artist?: string[];
  character?: string[];
  species?: string[];
  meta?: string[];
  lore?: string[];
  invalid?: string[];
};

type E621Post = {
  id?: number | string | null;
  file?: {
    url?: string | null;
    width?: number | null;
    height?: number | null;
    md5?: string | null;
    ext?: string | null;
    size?: number | null;
  } | null;
  preview?: { url?: string | null } | null;
  sample?: { url?: string | null } | null;
  score?: { total?: number | null } | null;
  created_at?: string | null;
  fav_count?: number | null;
  is_favorited?: boolean | null;
  /** 1, -1 or 0 for the authenticated account; absent when anonymous. */
  vote?: number | null;
  uploader_name?: string | null;
  tags?: E621TagBuckets | null;
  rating?: string | null;
  relationships?: {
    parent_id?: number | string | null;
    has_children?: boolean | null;
  } | null;
  pools?: (number | string)[] | null;
};

type E621Response = {
  post?: E621Post | null;
  posts?: E621Post[] | null;
};

const userAgent = () => config.e621.userAgent;

/**
 * One post's own page. Its tags, its parent and children and its pools all
 * come from this single body, so everything that needs any of them reads it
 * here rather than asking again.
 */
const readE621Post = async (
  site: BooruSiteRecord,
  postId: string
): Promise<E621Post | null> => {
  const res = await fetch(safeJoin(site.baseUrl, `/posts/${postId}.json`), {
    headers: buildHeaders(site)
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(
      `[tags] e621 post fetch failed (${res.status}): ${text.slice(0, 200)}`
    );
    return null;
  }
  try {
    return (JSON.parse(text) as E621Response)?.post ?? null;
  } catch {
    console.warn(`[tags] e621 parse failed: ${text.slice(0, 200)}`);
    return null;
  }
};

const buildE621Tags = (
  tags: E621TagBuckets | null | undefined
): TagResult[] => {
  if (!tags) return [];
  const bucket: TagResult[] = [];
  const pushTags = (category: string, values: string[]) => {
    for (const tag of values ?? []) {
      const cleaned = normalizeTag(tag);
      if (cleaned) bucket.push({ tag: cleaned, category });
    }
  };
  pushTags('general', tags.general ?? []);
  pushTags('artist', tags.artist ?? []);
  pushTags('character', tags.character ?? []);
  pushTags('species', tags.species ?? []);
  pushTags('meta', tags.meta ?? []);
  pushTags('lore', tags.lore ?? []);
  pushTags('invalid', tags.invalid ?? []);
  return bucket;
};

const buildHeaders = (site: BooruSiteRecord): Record<string, string> => {
  const headers: Record<string, string> = { 'User-Agent': userAgent() };
  if (site.username && site.apiKey) {
    headers.Authorization = basicAuthHeader(site.username, site.apiKey);
  }
  return headers;
};

const FAVORITES_PAGE_DELAY_MS = 200;

const e621Regex = (host: string) =>
  new RegExp(
    `^https?://(?:www\\.)?${escapeRegex(host)}/(?:posts|post/show)/(\\d+)`,
    'i'
  );

export const e621Engine: BooruEngineModule = {
  type: 'e621',
  credentialSchema: 'username+apikey',
  defaultCapabilities: {
    favorites: true,
    tags: true,
    sourceMatch: true,
    search: true,
    vote: true
  },
  supportsRelations: true,
  reportsHasChildren: true,
  supportsPools: true,
  defaultUserAgent: '',
  probePath: '/posts.json?limit=1',
  probeMatches: (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false;
    const posts = (body as { posts?: unknown }).posts;
    if (!Array.isArray(posts) || posts.length === 0)
      return Array.isArray(posts);
    const first = posts[0];
    if (!first || typeof first !== 'object') return false;
    const tags = (first as { tags?: unknown }).tags;
    return (
      !!tags &&
      typeof tags === 'object' &&
      Array.isArray((tags as { general?: unknown }).general)
    );
  },
  probeSample: (body: unknown) => {
    const posts = (body as { posts?: E621Post[] | null } | null)?.posts ?? null;
    const post = Array.isArray(posts) ? posts[0] : null;
    if (!post?.id) return null;
    const id = String(post.id);
    return {
      postId: id,
      thumbUrl: post.preview?.url ?? null,
      postPath: `/posts/${id}`
    };
  },

  async fetchPostTags(site, postId): Promise<TagResult[]> {
    if (!site.username || !site.apiKey) return [];
    const post = await readE621Post(site, postId);
    return buildE621Tags(post?.tags);
  },

  async fetchPostDetails(site, postId) {
    if (!site.username || !site.apiKey) return null;
    const post = await readE621Post(site, postId);
    if (!post) return null;
    return {
      tags: buildE621Tags(post.tags),
      relations: {
        parentId: toParentId(post.relationships?.parent_id),
        hasChildren: post.relationships?.has_children === true,
        poolIds: (post.pools ?? []).map((id) => String(id))
      }
    };
  },

  async fetchPostPoolIds(site, postId): Promise<string[]> {
    const post = await readE621Post(site, postId);
    return (post?.pools ?? []).map((id) => String(id));
  },

  async fetchPool(site, poolId) {
    const res = await fetch(safeJoin(site.baseUrl, `/pools/${poolId}.json`), {
      headers: buildHeaders(site)
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[pools] e621 pool fetch failed (${res.status}): ${text.slice(0, 200)}`
      );
      return null;
    }
    return toPoolRecord(JSON.parse(text));
  },

  async fetchPostByMd5(site, md5) {
    if (!site.username || !site.apiKey) return null;
    const res = await fetch(safeJoin(site.baseUrl, `/posts.json?md5=${md5}`), {
      headers: buildHeaders(site)
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(
        `[tags] e621 md5 fetch failed (${res.status}): ${text.slice(0, 200)}`
      );
      return null;
    }
    let data: E621Response;
    try {
      data = JSON.parse(text) as E621Response;
    } catch {
      console.warn(`[tags] e621 md5 parse failed: ${text.slice(0, 200)}`);
      return null;
    }
    const post =
      data?.post ?? (Array.isArray(data?.posts) ? data!.posts![0] : null);
    if (!post) return null;
    const tags = buildE621Tags(post.tags ?? null);
    const postId = post.id ? String(post.id) : null;
    return {
      tags,
      sourceUrl: postId ? safeJoin(site.baseUrl, `/posts/${postId}`) : null
    };
  },

  async searchPosts(site, options) {
    const tags = [...options.tags];
    // Two different questions, and e621 answers both natively. `order:rank`
    // weighs score against age (a 1400 from yesterday outranks a 1995 from
    // three days ago), which is what "hot" means. "Popular" is the flat
    // score ranking inside a window, spelled here as order:score + a date
    // floor rather than /popular.json: that endpoint drops the user's tags
    // entirely, and answers `scale=year` with the day's posts.
    if (options.sort === 'hot') tags.push('order:rank');
    if (options.sort === 'popular') {
      const period = windowRange(options.window, options.date);
      tags.push('order:score', dateMetatag(period));
    }
    const params = new URLSearchParams({
      tags: tags.join(' '),
      limit: String(options.limit),
      page: String(options.page)
    });
    const headers = buildHeaders(site);
    const res = await fetch(
      safeJoin(site.baseUrl, `/posts.json?${params.toString()}`),
      { headers }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${site.name} search failed (${res.status}): ${text.slice(0, 200)}`
      );
    }
    const data = JSON.parse(text) as E621Response;
    const posts: RemotePost[] = [];
    for (const post of data.posts ?? []) {
      if (!post?.id) continue;
      posts.push({
        remoteId: String(post.id),
        previewUrl: post.preview?.url ?? null,
        sampleUrl: post.sample?.url ?? null,
        fileUrl: post.file?.url ?? null,
        width: toNumberOrNull(post.file?.width),
        height: toNumberOrNull(post.file?.height),
        score: toNumberOrNull(post.score?.total),
        rating: post.rating ?? null,
        md5: post.file?.md5 ?? null,
        createdAt: toIsoOrNull(post.created_at),
        tags: buildE621Tags(post.tags),
        favCount: toNumberOrNull(post.fav_count),
        uploader: post.uploader_name ?? null,
        fileExt: post.file?.ext ?? null,
        fileSize: toNumberOrNull(post.file?.size),
        favorited:
          typeof post.is_favorited === 'boolean' ? post.is_favorited : null,
        parentId: toParentId(post.relationships?.parent_id),
        hasChildren: post.relationships?.has_children === true,
        poolIds: (post.pools ?? []).map((id) => String(id)),
        voted:
          post.vote === 1 || post.vote === -1 || post.vote === 0
            ? post.vote
            : null
      });
    }
    return { posts, downloadHeaders: headers };
  },

  async vote(site, postId, score) {
    if (!site.username || !site.apiKey)
      throw new Error(`${site.name} credentials missing`);
    const body = new URLSearchParams({
      score: String(score),
      no_unvote: 'true'
    });
    const res = await fetch(
      safeJoin(site.baseUrl, `/posts/${postId}/votes.json`),
      {
        method: 'POST',
        headers: {
          ...buildHeaders(site),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
      }
    );
    if (res.ok) return;
    const text = await res.text();
    throw new Error(
      `${site.name} vote failed (${res.status}): ${text.slice(0, 200)}`
    );
  },

  async fetchFavorites(site, ctx) {
    if (!site.username || !site.apiKey) {
      throw new Error(`${site.name} credentials missing`);
    }
    const headers = buildHeaders(site);
    const items: BooruRemoteFavorite[] = [];
    const limit = 320;
    let page = 1;
    for (;;) {
      const params = new URLSearchParams({
        tags: `fav:${site.username}`,
        limit: String(limit),
        page: String(page)
      });
      const res = await fetch(
        safeJoin(site.baseUrl, `/posts.json?${params.toString()}`),
        { headers }
      );
      const text = await res.text();
      if (!res.ok) {
        throw new Error(
          `${site.name} favorites failed (${res.status}): ${text.slice(0, 200)}`
        );
      }
      let data: E621Response;
      try {
        data = JSON.parse(text) as E621Response;
      } catch {
        throw new Error(
          `${site.name} favorites parse failed: ${text.slice(0, 200)}`
        );
      }
      const posts = Array.isArray(data.posts) ? data.posts : [];
      if (!posts.length) break;
      ctx?.onPage?.(page, posts.length);
      for (const post of posts) {
        const id = post?.id ? String(post.id) : null;
        const fileUrl = post?.file?.url ?? null;
        if (!id) continue;
        items.push({
          provider: site.id,
          remoteId: id,
          sourceUrl: safeJoin(site.baseUrl, `/posts/${id}`),
          fileUrl
        });
      }
      if (posts.length < limit) break;
      page += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, FAVORITES_PAGE_DELAY_MS)
      );
    }
    return { items, downloadHeaders: headers };
  },

  async favorite(site, postId) {
    if (!site.username || !site.apiKey)
      throw new Error(`${site.name} credentials missing`);
    const body = new URLSearchParams({ post_id: postId });
    const res = await fetch(safeJoin(site.baseUrl, '/favorites.json'), {
      method: 'POST',
      headers: {
        ...buildHeaders(site),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    if (res.ok || res.status === 422) return;
    const text = await res.text();
    throw new Error(
      `${site.name} favorite failed (${res.status}): ${text.slice(0, 200)}`
    );
  },

  async unfavorite(site, postId) {
    if (!site.username || !site.apiKey)
      throw new Error(`${site.name} credentials missing`);
    const res = await fetch(
      safeJoin(site.baseUrl, `/favorites/${postId}.json`),
      {
        method: 'DELETE',
        headers: buildHeaders(site)
      }
    );
    if (res.ok || res.status === 404) return;
    const text = await res.text();
    throw new Error(
      `${site.name} unfavorite failed (${res.status}): ${text.slice(0, 200)}`
    );
  },

  extractIdFromUrl(url, site) {
    const host = new URL(site.baseUrl).hostname
      .replace(/^www\./, '')
      .toLowerCase();
    const match = url.match(e621Regex(host));
    if (!match?.[1]) return null;
    return { remoteId: match[1] };
  },

  buildPostUrl(site, postId) {
    return safeJoin(site.baseUrl, `/posts/${postId}`);
  }
};
