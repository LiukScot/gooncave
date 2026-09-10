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
};

export type SubscriptionFeedCursor = {
  sortAt: string;
  discoveredAt: string;
  siteId: string;
  remoteId: string;
};

export type SubscriptionFeedState = {
  nextTagIndex: number;
  feedCursor: string | null;
  feedExhausted: boolean;
  updatedAt: string;
  lastError: string | null;
};

export type IndexedSubscriptionPost = {
  site: Pick<BooruSiteRecord, 'id' | 'name' | 'engine' | 'baseUrl'>;
  post: RemotePost;
};

const stateFor = (userId: string, siteId: string): SubscriptionFeedState => {
  const row = sqlite
    .prepare(
      `SELECT next_tag_index, feed_cursor, feed_exhausted, updated_at, last_error
       FROM subscription_feed_sync_state
       WHERE user_id = ? AND site_id = ?`
    )
    .get(userId, siteId) as
    | {
        next_tag_index: number;
        feed_cursor: string | null;
        feed_exhausted: number;
        updated_at: string;
        last_error: string | null;
      }
    | undefined;
  return row
    ? {
        nextTagIndex: row.next_tag_index,
        feedCursor: row.feed_cursor,
        feedExhausted: row.feed_exhausted === 1,
        updatedAt: row.updated_at,
        lastError: row.last_error
      }
    : {
        nextTagIndex: 0,
        feedCursor: null,
        feedExhausted: false,
        updatedAt: new Date(0).toISOString(),
        lastError: null
      };
};

export const subscriptionFeedRepo = {
  clearForUser(userId: string): void {
    sqlite.transaction(() => {
      sqlite
        .prepare('DELETE FROM subscription_feed_items WHERE user_id = ?')
        .run(userId);
      sqlite
        .prepare('DELETE FROM subscription_feed_sync_state WHERE user_id = ?')
        .run(userId);
    })();
  },

  upsertPosts(userId: string, siteId: string, posts: RemotePost[]): void {
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      `INSERT INTO subscription_feed_items
       (user_id, site_id, remote_id, post_json, sort_at, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, site_id, remote_id) DO UPDATE SET
         post_json = excluded.post_json`
    );
    sqlite.transaction(() => {
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
    })();
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
                feed.post_json, feed.sort_at, feed.discovered_at, feed.remote_id
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
        post: JSON.parse(row.post_json) as RemotePost
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
    updates: Partial<Omit<SubscriptionFeedState, 'updatedAt'>>
  ): SubscriptionFeedState {
    const current = stateFor(userId, siteId);
    const next = { ...current, ...updates, updatedAt: new Date().toISOString() };
    sqlite
      .prepare(
        `INSERT INTO subscription_feed_sync_state
         (user_id, site_id, next_tag_index, feed_cursor, feed_exhausted, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, site_id) DO UPDATE SET
           next_tag_index = excluded.next_tag_index,
           feed_cursor = excluded.feed_cursor,
           feed_exhausted = excluded.feed_exhausted,
           updated_at = excluded.updated_at,
           last_error = excluded.last_error`
      )
      .run(
        userId,
        siteId,
        next.nextTagIndex,
        next.feedCursor,
        next.feedExhausted ? 1 : 0,
        next.updatedAt,
        next.lastError
      );
    return next;
  }
};
