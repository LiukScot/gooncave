import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { FolderRecord, FolderStatus, FolderType } from '../../db/types';
import { sqlite } from '../client';

type FolderRow = {
  id: string;
  user_id: string | null;
  path: string;
  type?: FolderType | null;
  created_at: string;
  updated_at: string;
  last_scan_at?: string | null;
  status: FolderStatus;
};

const mapFolderRow = (row: FolderRow): FolderRecord => ({
  id: row.id,
  userId: row.user_id ?? null,
  path: row.path,
  type: (row.type ?? 'LOCAL') as FolderType,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastScanAt: row.last_scan_at ?? null,
  status: row.status as FolderStatus
});

const normalizeStoredPath = (value: string) => path.resolve(value);

const isSameOrInsideStoredPath = (candidatePath: string, basePath: string) => {
  const resolvedCandidate = normalizeStoredPath(candidatePath);
  const resolvedBase = normalizeStoredPath(basePath);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
};

export const foldersRepo = {
  async ensureFolders(folderPaths: string[], userId?: string) {
    if (folderPaths.length === 0) return [];
    const now = new Date().toISOString();
    const ensured: FolderRecord[] = [];

    const selectByPath = userId
      ? sqlite.prepare('SELECT * FROM folders WHERE path = ? AND user_id = ?')
      : sqlite.prepare('SELECT * FROM folders WHERE path = ?');
    const insertFolder = userId
      ? sqlite.prepare(
          `INSERT INTO folders (id, user_id, path, type, created_at, updated_at, last_scan_at, status)
           VALUES (?, ?, ?, 'LOCAL', ?, ?, ?, ?)`
        )
      : sqlite.prepare(
          `INSERT INTO folders (id, path, type, created_at, updated_at, last_scan_at, status)
           VALUES (?, ?, 'LOCAL', ?, ?, ?, ?)`
        );

    for (const folderPath of folderPaths) {
      await fs.promises.mkdir(folderPath, { recursive: true });
    }

    const tx = sqlite.transaction(() => {
      for (const folderPath of folderPaths) {
        const existing = (userId ? selectByPath.get(folderPath, userId) : selectByPath.get(folderPath)) as FolderRow | undefined;
        if (!existing) {
          const folder: FolderRecord = {
            id: randomUUID(),
            userId: userId ?? null,
            path: folderPath,
            type: 'LOCAL',
            createdAt: now,
            updatedAt: now,
            lastScanAt: null,
            status: 'IDLE'
          };
          if (userId) {
            insertFolder.run(
              folder.id,
              folder.userId,
              folder.path,
              folder.createdAt,
              folder.updatedAt,
              folder.lastScanAt,
              folder.status
            );
          } else {
            insertFolder.run(folder.id, folder.path, folder.createdAt, folder.updatedAt, folder.lastScanAt, folder.status);
          }
          ensured.push(folder);
        } else {
          ensured.push(mapFolderRow(existing));
        }
      }
    });

    tx();
    return ensured;
  },
  async listFolders(userId?: string) {
    const rows = userId
      ? (sqlite.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY created_at DESC').all(userId) as FolderRow[])
      : (sqlite.prepare('SELECT * FROM folders ORDER BY created_at DESC').all() as FolderRow[]);
    return rows.map(mapFolderRow);
  },
  async findFolderById(id: string, userId?: string) {
    const row = (userId
      ? sqlite.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(id, userId)
      : sqlite.prepare('SELECT * FROM folders WHERE id = ?').get(id)) as FolderRow | undefined;
    return row ? mapFolderRow(row) : null;
  },
  async findFolderByPath(folderPath: string, userId?: string) {
    const row = (userId
      ? sqlite.prepare('SELECT * FROM folders WHERE path = ? AND user_id = ?').get(folderPath, userId)
      : sqlite.prepare('SELECT * FROM folders WHERE path = ?').get(folderPath)) as FolderRow | undefined;
    return row ? mapFolderRow(row) : null;
  },
  async addFolder(folderPath: string, userId?: string) {
    const now = new Date().toISOString();
    await fs.promises.mkdir(folderPath, { recursive: true });
    const folder: FolderRecord = {
      id: randomUUID(),
      userId: userId ?? null,
      path: folderPath,
      type: 'LOCAL',
      createdAt: now,
      updatedAt: now,
      lastScanAt: null,
      status: 'IDLE'
    };
    if (userId) {
      sqlite
        .prepare(
          `INSERT INTO folders (id, user_id, path, type, created_at, updated_at, last_scan_at, status)
           VALUES (?, ?, ?, 'LOCAL', ?, ?, ?, ?)`
        )
        .run(folder.id, userId, folder.path, folder.createdAt, folder.updatedAt, folder.lastScanAt, folder.status);
    } else {
      sqlite
        .prepare(
          `INSERT INTO folders (id, path, type, created_at, updated_at, last_scan_at, status)
           VALUES (?, ?, 'LOCAL', ?, ?, ?, ?)`
        )
        .run(folder.id, folder.path, folder.createdAt, folder.updatedAt, folder.lastScanAt, folder.status);
    }
    return folder;
  },
  async updateFolder(id: string, updates: Partial<Omit<FolderRecord, 'id'>>, userId?: string) {
    const existing = await this.findFolderById(id, userId);
    if (!existing) return null;
    await fs.promises.mkdir((updates.path ?? existing.path), { recursive: true });
    const folder: FolderRecord = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    sqlite
      .prepare(`UPDATE folders SET user_id = ?, path = ?, type = ?, created_at = ?, updated_at = ?, last_scan_at = ?, status = ? WHERE id = ?`)
      .run(folder.userId, folder.path, folder.type, folder.createdAt, folder.updatedAt, folder.lastScanAt, folder.status, folder.id);
    return folder;
  },
  async deleteFolder(id: string, userId?: string) {
    const folder = await this.findFolderById(id, userId);
    if (!folder) return false;
    if (userId) {
      sqlite.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ? AND value = ?').run(
        userId,
        'favorites_root_id',
        id
      );
    }
    if (userId) {
      sqlite.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
    } else {
      sqlite.prepare('DELETE FROM folders WHERE id = ?').run(id);
    }
    return true;
  },
  async deleteFilesInFolderByPrefixes(folderId: string, prefixes: string[], userId?: string) {
    const folder = await this.findFolderById(folderId, userId);
    if (!folder) return 0;

    const normalizedPrefixes = prefixes.map((prefix) => normalizeStoredPath(prefix));
    if (normalizedPrefixes.length === 0) return 0;

    const rows = sqlite.prepare('SELECT id, path FROM files WHERE folder_id = ?').all(folderId) as { id: string; path: string }[];
    const idsToDelete = rows
      .filter((row) => normalizedPrefixes.some((prefix) => isSameOrInsideStoredPath(row.path, prefix)))
      .map((row) => row.id);

    if (idsToDelete.length === 0) return 0;

    const chunkSize = 500;
    const tx = sqlite.transaction(() => {
      for (let i = 0; i < idsToDelete.length; i += chunkSize) {
        const chunk = idsToDelete.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(', ');
        sqlite.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...chunk);
      }
    });

    tx();
    return idsToDelete.length;
  }
};
