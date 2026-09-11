import type { RemotePost } from '../../lib/booruEngines/types';
import { sqlite } from '../client';
import type { BooruSiteRecord } from '../types';

type FeedRow = {
  site_id: string;
  site_name: string;
  engine: BooruSiteRecord['engine'];
  base_url: string;
  post_json: string;
  sort_at: string;
  discovered_at: string;
  remote_id: string;
  favorited_override: number | null;
};

export type SubscriptionFeedCursor = {
  sortAt: string;
  discoveredAt: string;
  siteId: string;
  remoteId: string;
};

export type SubscriptionFeedState = {
  nextTagIndex: number;
  headTagIndex: number;
  searchPage: number;
  searchPageHadPosts: boolean;
  searchExhausted: boolean;
  feedCursor: string | null;
  feedHeadCursor: string | null;
  feedExhausted: boolean;
  updatedAt: string;
  lastError: string | null;
};

export type IndexedSubscriptionPost = {
  site: Pick<BooruSiteRecord, 'id' | 'name' | 'engine' | 'baseUrl'>;
  post: RemotePost;
  favoritedOverride: boolean | null;
};

const GENERATION_KEY = 'subscriptions.feedGeneration';

const generationFor = (userId: string): number => {
  const row = sqlite
    .prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, GENERATION_KEY) as { value: string } | undefined;
  const value = Number(row?.value ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const stateFor = (userId: string, siteId: string): SubscriptionFeedState => {
  const row = sqlite
    .prepare(
      `SELECT next_tag_index, head_tag_index, search_page,
              search_page_had_posts, search_exhausted, feed_cursor,
              feed_head_cursor, feed_exhausted, updated_at, last_error
       FROM subscription_feed_sync_state
       WHERE user_id = ? AND site_id = ?`
    )
    .get(userId, siteId) as
    | {
        next_tag_index: number;
        head_tag_index: number;
        search_page: number;
        search_page_had_posts: number;
        search_exhausted: number;
        feed_cursor: string | null;
        feed_head_cursor: string | null;
        feed_exhausted: number;
        updated_at: string;
        last_error: string | null;
      }
    | undefined;
  return row
    ? {
        nextTagIndex: row.next_tag_index,
        headTagIndex: row.head_tag_index,
        searchPage: row.search_page,
        searchPageHadPosts: row.search_page_had_posts === 1,
        searchExhausted: row.search_exhausted === 1,
        feedCursor: row.feed_cursor,
        feedHeadCursor: row.feed_head_cursor,
        feedExhausted: row.feed_exhausted === 1,
        updatedAt: row.updated_at,
        lastError: row.last_error
      }
    : {
        nextTagIndex: 0,
        headTagIndex: 0,
        searchPage: 2,
        searchPageHadPosts: false,
        searchExhausted: false,
        feedCursor: null,
        feedHeadCursor: null,
        feedExhausted: false,
        updatedAt: new Date(0).toISOString(),
        lastError: null
      };
};

export const subscriptionFeedRepo = {
  getGeneration: generationFor,

  clearForUser(userId: string): void {
    sqlite.transaction(() => {
      const nextGeneration = generationFor(userId) + 1;
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO user_settings (user_id, key, value)
           VALUES (?, ?, ?)`
        )
        .run(userId, GENERATION_KEY, String(nextGeneration));
      sqlite
        .prepare('DELETE FROM subscription_feed_items WHERE user_id = ?')
        .run(userId);
      sqlite
        .prepare('DELETE FROM subscription_feed_sync_state WHERE user_id = ?')
        .run(userId);
    })();
  },

  upsertPosts(
    userId: string,
    siteId: string,
    posts: RemotePost[],
    generation = generationFor(userId)
  ): boolean {
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      `INSERT INTO subscription_feed_items
       (user_id, site_id, remote_id, post_json, sort_at, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, site_id, remote_id) DO UPDATE SET
         post_json = excluded.post_json`
    );
    return sqlite.transaction(() => {
      if (generationFor(userId) !== generation) return false;
      for (const post of posts) {
        insert.run(
          userId,
          siteId,
          post.remoteId,
          JSON.stringify(post),
          post.createdAt ?? now,
          now
        );
      }
      return true;
    })();
  },

  hasPostsForSite(userId: string, siteId: string): boolean {
    return Boolean(
      sqlite
        .prepare(
          `SELECT 1 FROM subscription_feed_items
           WHERE user_id = ? AND site_id = ? LIMIT 1`
        )
        .get(userId, siteId)
    );
  },

  hasAnyPosts(userId: string, siteId: string, remoteIds: string[]): boolean {
    if (!remoteIds.length) return false;
    const placeholders = remoteIds.map(() => '?').join(',');
    return Boolean(
      sqlite
        .prepare(
          `SELECT 1 FROM subscription_feed_items
           WHERE user_id = ? AND site_id = ?
             AND remote_id IN (${placeholders}) LIMIT 1`
        )
        .get(userId, siteId, ...remoteIds)
    );
  },

  setFavoriteOverride(
    userId: string,
    siteId: string,
    remoteId: string,
    favorited: boolean
  ): void {
    sqlite
      .prepare(
        `UPDATE subscription_feed_items SET favorited_override = ?
         WHERE user_id = ? AND site_id = ? AND remote_id = ?`
      )
      .run(favorited ? 1 : 0, userId, siteId, remoteId);
  },

  listPosts(
    userId: string,
    options: {
      siteIds?: string[];
      cursor?: SubscriptionFeedCursor;
      limit: number;
    }
  ): {
    items: IndexedSubscriptionPost[];
    hasMore: boolean;
    nextCursor: SubscriptionFeedCursor | null;
  } {
    const siteClause = options.siteIds?.length
      ? `AND feed.site_id IN (${options.siteIds.map(() => '?').join(',')})`
      : '';
    const params: Array<string | number> = [userId];
    if (options.siteIds?.length) params.push(...options.siteIds);
    const cursorClause = options.cursor
      ? `AND (
           feed.sort_at < ? OR
           (feed.sort_at = ? AND feed.discovered_at < ?) OR
           (feed.sort_at = ? AND feed.discovered_at = ? AND feed.site_id > ?) OR
           (feed.sort_at = ? AND feed.discovered_at = ? AND feed.site_id = ? AND feed.remote_id > ?)
         )`
      : '';
    if (options.cursor) {
      const cursor = options.cursor;
      params.push(
        cursor.sortAt,
        cursor.sortAt,
        cursor.discoveredAt,
        cursor.sortAt,
        cursor.discoveredAt,
        cursor.siteId,
        cursor.sortAt,
        cursor.discoveredAt,
        cursor.siteId,
        cursor.remoteId
      );
    }
    params.push(options.limit + 1);
    const rows = sqlite
      .prepare(
        `SELECT feed.site_id, site.name AS site_name, site.engine, site.base_url,
                feed.post_json, feed.sort_at, feed.discovered_at, feed.remote_id,
                feed.favorited_override
         FROM subscription_feed_items feed
         JOIN user_booru_sites site ON site.id = feed.site_id
         WHERE feed.user_id = ? AND site.enabled = 1 ${siteClause} ${cursorClause}
         ORDER BY feed.sort_at DESC,
                  feed.discovered_at DESC, feed.site_id, feed.remote_id
         LIMIT ?`
      )
      .all(...params) as FeedRow[];
    const visibleRows = rows.slice(0, options.limit);
    const last = visibleRows[visibleRows.length - 1];
    return {
      items: visibleRows.map((row) => ({
        site: {
          id: row.site_id,
          name: row.site_name,
          engine: row.engine,
          baseUrl: row.base_url
        },
        post: JSON.parse(row.post_json) as RemotePost,
        favoritedOverride:
          row.favorited_override === null ? null : row.favorited_override === 1
      })),
      hasMore: rows.length > options.limit,
      nextCursor: last
        ? {
            sortAt: last.sort_at,
            discoveredAt: last.discovered_at,
            siteId: last.site_id,
            remoteId: last.remote_id
          }
        : null
    };
  },

  getState: stateFor,

  saveState(
    userId: string,
    siteId: string,
    updates: Partial<Omit<SubscriptionFeedState, 'updatedAt'>>,
    generation = generationFor(userId)
  ): SubscriptionFeedState | null {
    return sqlite.transaction(() => {
      if (generationFor(userId) !== generation) return null;
      const current = stateFor(userId, siteId);
      const next = {
        ...current,
        ...updates,
        updatedAt: new Date().toISOString()
      };
      sqlite
        .prepare(
        `INSERT INTO subscription_feed_sync_state
         (user_id, site_id, next_tag_index, head_tag_index, search_page,
          search_page_had_posts, search_exhausted, feed_cursor,
          feed_head_cursor, feed_exhausted, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, site_id) DO UPDATE SET
           next_tag_index = excluded.next_tag_index,
           head_tag_index = excluded.head_tag_index,
           search_page = excluded.search_page,
           search_page_had_posts = excluded.search_page_had_posts,
           search_exhausted = excluded.search_exhausted,
           feed_cursor = excluded.feed_cursor,
           feed_head_cursor = excluded.feed_head_cursor,
           feed_exhausted = excluded.feed_exhausted,
           updated_at = excluded.updated_at,
           last_error = excluded.last_error`
        )
        .run(
          userId,
          siteId,
          next.nextTagIndex,
          next.headTagIndex,
          next.searchPage,
          next.searchPageHadPosts ? 1 : 0,
          next.searchExhausted ? 1 : 0,
          next.feedCursor,
          next.feedHeadCursor,
          next.feedExhausted ? 1 : 0,
          next.updatedAt,
          next.lastError
        );
      return next;
    })();
  }
};
