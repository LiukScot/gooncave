import { randomUUID } from 'crypto';

import type { BooruSiteInput, BooruSiteRecord } from '../../db/types';
import { sqlite } from '../client';

type BooruSiteRow = {
  id: string;
  user_id: string;
  name: string;
  engine: string;
  base_url: string;
  username?: string | null;
  api_key?: string | null;
  is_preset: number;
  preset_key?: string | null;
  enabled: number;
  cap_favorites: number;
  cap_tags: number;
  cap_source_match: number;
  cap_search: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const mapBooruSiteRow = (row: BooruSiteRow): BooruSiteRecord => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  engine: row.engine as BooruSiteRecord['engine'],
  baseUrl: row.base_url,
  username: row.username ?? null,
  apiKey: row.api_key ?? null,
  isPreset: row.is_preset === 1,
  presetKey: row.preset_key ?? null,
  enabled: row.enabled === 1,
  capFavorites: row.cap_favorites === 1,
  capTags: row.cap_tags === 1,
  capSourceMatch: row.cap_source_match === 1,
  capSearch: row.cap_search === 1,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const booruSitesRepo = {
  async listBooruSites(userId: string): Promise<BooruSiteRecord[]> {
    const rows = sqlite
      .prepare('SELECT * FROM user_booru_sites WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC')
      .all(userId) as BooruSiteRow[];
    return rows.map(mapBooruSiteRow);
  },
  async getBooruSite(id: string, userId: string): Promise<BooruSiteRecord | null> {
    const row = sqlite
      .prepare('SELECT * FROM user_booru_sites WHERE id = ? AND user_id = ?')
      .get(id, userId) as BooruSiteRow | undefined;
    return row ? mapBooruSiteRow(row) : null;
  },
  async findBooruSiteByPresetKey(presetKey: string, userId: string): Promise<BooruSiteRecord | null> {
    const row = sqlite
      .prepare('SELECT * FROM user_booru_sites WHERE preset_key = ? AND user_id = ?')
      .get(presetKey, userId) as BooruSiteRow | undefined;
    return row ? mapBooruSiteRow(row) : null;
  },
  async findBooruSiteByBaseUrl(baseUrl: string, userId: string): Promise<BooruSiteRecord | null> {
    const row = sqlite
      .prepare('SELECT * FROM user_booru_sites WHERE base_url = ? AND user_id = ?')
      .get(baseUrl, userId) as BooruSiteRow | undefined;
    return row ? mapBooruSiteRow(row) : null;
  },
  async insertBooruSite(input: BooruSiteInput, userId: string): Promise<BooruSiteRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const insertTx = sqlite.transaction(() => {
      const nextSortOrder =
        input.sortOrder ??
        (
          sqlite
            .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM user_booru_sites WHERE user_id = ?')
            .get(userId) as { next: number }
        ).next;
      sqlite.prepare(
        `INSERT INTO user_booru_sites
           (id, user_id, name, engine, base_url, username, api_key,
            is_preset, preset_key, enabled,
            cap_favorites, cap_tags, cap_source_match, cap_search,
            sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        userId,
        input.name,
        input.engine,
        input.baseUrl,
        input.username ?? null,
        input.apiKey ?? null,
        input.isPreset ? 1 : 0,
        input.presetKey ?? null,
        input.enabled === false ? 0 : 1,
        input.capFavorites ? 1 : 0,
        input.capTags ? 1 : 0,
        input.capSourceMatch ? 1 : 0,
        input.capSearch ? 1 : 0,
        nextSortOrder,
        now,
        now
      );
    });
    insertTx();
    const row = sqlite.prepare('SELECT * FROM user_booru_sites WHERE id = ?').get(id) as BooruSiteRow;
    return mapBooruSiteRow(row);
  },
  async updateBooruSite(id: string, updates: Partial<BooruSiteInput>, userId: string): Promise<BooruSiteRecord | null> {
    const existing = sqlite
      .prepare('SELECT * FROM user_booru_sites WHERE id = ? AND user_id = ?')
      .get(id, userId) as BooruSiteRow | undefined;
    if (!existing) return null;
    const merged: BooruSiteRow = {
      ...existing,
      name: updates.name ?? existing.name,
      engine: updates.engine ?? existing.engine,
      base_url: updates.baseUrl ?? existing.base_url,
      username: updates.username !== undefined ? updates.username : existing.username,
      api_key: updates.apiKey !== undefined ? updates.apiKey : existing.api_key,
      is_preset: updates.isPreset !== undefined ? (updates.isPreset ? 1 : 0) : existing.is_preset,
      preset_key: updates.presetKey !== undefined ? updates.presetKey : existing.preset_key,
      enabled: updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled,
      cap_favorites: updates.capFavorites !== undefined ? (updates.capFavorites ? 1 : 0) : existing.cap_favorites,
      cap_tags: updates.capTags !== undefined ? (updates.capTags ? 1 : 0) : existing.cap_tags,
      cap_source_match:
        updates.capSourceMatch !== undefined ? (updates.capSourceMatch ? 1 : 0) : existing.cap_source_match,
      cap_search: updates.capSearch !== undefined ? (updates.capSearch ? 1 : 0) : existing.cap_search,
      sort_order: updates.sortOrder ?? existing.sort_order,
      updated_at: new Date().toISOString()
    };
    sqlite.prepare(
      `UPDATE user_booru_sites
       SET name = ?, engine = ?, base_url = ?, username = ?, api_key = ?, is_preset = ?, preset_key = ?,
           enabled = ?, cap_favorites = ?, cap_tags = ?, cap_source_match = ?, cap_search = ?,
           sort_order = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      merged.name,
      merged.engine,
      merged.base_url,
      merged.username ?? null,
      merged.api_key ?? null,
      merged.is_preset,
      merged.preset_key ?? null,
      merged.enabled,
      merged.cap_favorites,
      merged.cap_tags,
      merged.cap_source_match,
      merged.cap_search,
      merged.sort_order,
      merged.updated_at,
      id,
      userId
    );
    return mapBooruSiteRow(merged);
  },
  async deleteBooruSite(id: string, userId: string): Promise<boolean> {
    const tx = sqlite.transaction(() => {
      const result = sqlite
        .prepare('DELETE FROM user_booru_sites WHERE id = ? AND user_id = ? AND is_preset = 0')
        .run(id, userId);
      if ((result.changes ?? 0) === 0) return false;
      sqlite.prepare('DELETE FROM favorite_items WHERE provider = ? AND user_id = ?').run(id, userId);
      return true;
    });
    return tx() as boolean;
  },
  async reorderBooruSites(orderedIds: string[], userId: string): Promise<void> {
    const stmt = sqlite.prepare(
      'UPDATE user_booru_sites SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    );
    const now = new Date().toISOString();
    const tx = sqlite.transaction(() => {
      orderedIds.forEach((id, idx) => {
        stmt.run(idx, now, id, userId);
      });
    });
    tx();
  }
};
