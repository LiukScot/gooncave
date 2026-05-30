import { randomUUID } from 'crypto';

import type { FolderRecord, FolderStatus, ScanRecord, ScanStatus } from '../../db/types';
import { sqlite } from '../client';

type FolderRow = {
  id: string;
  user_id: string | null;
  path: string;
  type?: string | null;
  created_at: string;
  updated_at: string;
  last_scan_at?: string | null;
  status: string;
};

type ScanRow = {
  id: string;
  folder_id: string;
  status: string;
  progress?: number | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
};

const mapFolderRow = (row: FolderRow): FolderRecord => ({
  id: row.id,
  userId: row.user_id ?? null,
  path: row.path,
  type: (row.type ?? 'LOCAL') as FolderRecord['type'],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastScanAt: row.last_scan_at ?? null,
  status: row.status as FolderStatus
});

const mapScanRow = (row: ScanRow): ScanRecord => ({
  id: row.id,
  folderId: row.folder_id,
  status: row.status as ScanStatus,
  progress: Number(row.progress ?? 0),
  error: row.error ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export const scansRepo = {
  async findScanById(id: string, userId?: string) {
    const row = (userId
      ? sqlite
          .prepare(
            `SELECT s.*
             FROM scans s
             JOIN folders f ON f.id = s.folder_id
             WHERE s.id = ? AND f.user_id = ?`
          )
          .get(id, userId)
      : sqlite.prepare('SELECT * FROM scans WHERE id = ?').get(id)) as ScanRow | undefined;
    return row ? mapScanRow(row) : null;
  },

  async findFolderById(id: string) {
    const row = sqlite.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
    return row ? mapFolderRow(row) : null;
  },

  async createScan(folderId: string) {
    const now = new Date().toISOString();
    const scan: ScanRecord = {
      id: randomUUID(),
      folderId,
      status: 'PENDING',
      progress: 0,
      error: null,
      createdAt: now,
      updatedAt: now
    };
    sqlite.prepare(
      `INSERT INTO scans (id, folder_id, status, progress, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(scan.id, scan.folderId, scan.status, scan.progress, scan.error, scan.createdAt, scan.updatedAt);
    return scan;
  },

  async updateScan(id: string, updates: Partial<Omit<ScanRecord, 'id' | 'folderId'>>) {
    const existing = await this.findScanById(id);
    if (!existing) return null;
    const scan: ScanRecord = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    sqlite.prepare(
      `UPDATE scans SET status = ?, progress = ?, error = ?, created_at = ?, updated_at = ? WHERE id = ?`
    ).run(scan.status, scan.progress, scan.error, scan.createdAt, scan.updatedAt, scan.id);
    return scan;
  },

  async clearPendingAndRunning(userId?: string) {
    const now = new Date().toISOString();
    const tx = sqlite.transaction(() => {
      if (userId) {
        sqlite.prepare(
          `UPDATE scans
           SET status = 'FAILED', error = 'Cleared by user', updated_at = ?
           WHERE status IN ('PENDING', 'RUNNING')
             AND folder_id IN (SELECT id FROM folders WHERE user_id = ?)`
        ).run(now, userId);
        sqlite.prepare(
          `UPDATE folders SET status = 'IDLE', updated_at = ? WHERE status = 'SCANNING' AND user_id = ?`
        ).run(now, userId);
        return;
      }
      sqlite.prepare(
        `UPDATE scans SET status = 'FAILED', error = 'Cleared by user', updated_at = ? WHERE status IN ('PENDING', 'RUNNING')`
      ).run(now);
      sqlite.prepare(`UPDATE folders SET status = 'IDLE', updated_at = ? WHERE status = 'SCANNING'`).run(now);
    });
    tx();
  },

  async stopScan(scanId: string) {
    const scan = await this.findScanById(scanId);
    if (!scan) return null;
    const folder = await this.findFolderById(scan.folderId);
    if (scan.status === 'COMPLETED' || scan.status === 'FAILED') {
      return { scan, folder };
    }

    const now = new Date().toISOString();
    const updatedScan: ScanRecord = {
      ...scan,
      status: 'FAILED',
      error: 'Stopped by user',
      progress: 0,
      updatedAt: now
    };
    sqlite.prepare(`UPDATE scans SET status = ?, error = ?, progress = ?, updated_at = ? WHERE id = ?`).run(
      updatedScan.status,
      updatedScan.error,
      updatedScan.progress,
      updatedScan.updatedAt,
      updatedScan.id
    );

    let updatedFolder = folder;
    if (folder) {
      updatedFolder = {
        ...folder,
        status: 'IDLE',
        updatedAt: now
      };
      sqlite.prepare(`UPDATE folders SET status = ?, updated_at = ? WHERE id = ?`).run(
        updatedFolder.status,
        updatedFolder.updatedAt,
        updatedFolder.id
      );
    }

    return { scan: updatedScan, folder: updatedFolder };
  }
};
