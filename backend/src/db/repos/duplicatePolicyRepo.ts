import { randomUUID } from 'crypto';

import { sqlite } from '../client';

export type DuplicatePolicyStyle = 'favorite_all' | 'preferred_only';
export type DuplicatePolicyActionKind =
  | 'add_favorite'
  | 'confirm_favorite'
  | 'remove_favorite'
  | 'reuse_file'
  | 'delete_file'
  | 'attention';

export type DuplicatePolicyAction = {
  id: string;
  groupKey: string;
  kind: DuplicatePolicyActionKind;
  status: 'planned' | 'completed' | 'failed' | 'skipped';
  provider: string | null;
  remoteId: string | null;
  fileId: string | null;
  fileName: string | null;
  message: string;
  position: number;
};

type RunRow = {
  id: string;
  kind: 'preview' | 'apply';
  status: 'planning' | 'ready' | 'running' | 'completed' | 'partial' | 'failed';
  style: DuplicatePolicyStyle;
  preferred_providers: string;
  reason: string;
  total_groups: number;
  processed_groups: number;
  added: number;
  removed: number;
  reused: number;
  deleted: number;
  needs_attention: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ActionRow = {
  id: string;
  group_key: string;
  kind: DuplicatePolicyActionKind;
  status: DuplicatePolicyAction['status'];
  provider: string | null;
  remote_id: string | null;
  file_id: string | null;
  file_name: string | null;
  message: string;
  position: number;
};

const parseProviders = (value: string) => {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
    ? parsed
    : [];
};

const mapAction = (row: ActionRow): DuplicatePolicyAction => ({
  id: row.id,
  groupKey: row.group_key,
  kind: row.kind,
  status: row.status,
  provider: row.provider,
  remoteId: row.remote_id,
  fileId: row.file_id,
  fileName: row.file_name,
  message: row.message,
  position: row.position
});

const mapRun = (row: RunRow, actions: DuplicatePolicyAction[]) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  style: row.style,
  preferredProviders: parseProviders(row.preferred_providers),
  reason: row.reason,
  totalGroups: row.total_groups,
  processedGroups: row.processed_groups,
  counts: {
    added: row.added,
    removed: row.removed,
    reused: row.reused,
    deleted: row.deleted,
    needsAttention: row.needs_attention
  },
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  actions
});

export const duplicatePolicyRepo = {
  createRun(input: {
    userId: string;
    kind: 'preview' | 'apply';
    style: DuplicatePolicyStyle;
    preferredProviders: string[];
    reason: string;
  }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const status = input.kind === 'apply' ? 'running' : 'planning';
    sqlite.prepare(
      `INSERT INTO duplicate_policy_runs
       (id, user_id, kind, status, style, preferred_providers, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.userId,
      input.kind,
      status,
      input.style,
      JSON.stringify(input.preferredProviders),
      input.reason,
      now,
      now
    );
    return id;
  },
  addActions(runId: string, actions: Omit<DuplicatePolicyAction, 'id' | 'status' | 'position'>[]) {
    const now = new Date().toISOString();
    const insert = sqlite.prepare(
      `INSERT INTO duplicate_policy_actions
       (id, run_id, group_key, kind, status, provider, remote_id, file_id, file_name, message, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    sqlite.transaction(() => {
      actions.forEach((action, position) => {
        insert.run(
          randomUUID(), runId, action.groupKey, action.kind, action.provider,
          action.remoteId, action.fileId, action.fileName, action.message,
          position, now, now
        );
      });
    })();
  },
  updateRun(runId: string, patch: Record<string, string | number | null>) {
    const allowed = new Set([
      'status', 'total_groups', 'processed_groups', 'added', 'removed',
      'reused', 'deleted', 'needs_attention', 'error', 'completed_at'
    ]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (!entries.length) return;
    entries.push(['updated_at', new Date().toISOString()]);
    sqlite.prepare(
      `UPDATE duplicate_policy_runs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`
    ).run(...entries.map(([, value]) => value), runId);
  },
  updateAction(id: string, status: DuplicatePolicyAction['status'], message?: string) {
    if (message === undefined) {
      sqlite.prepare(
        'UPDATE duplicate_policy_actions SET status = ?, updated_at = ? WHERE id = ?'
      ).run(status, new Date().toISOString(), id);
    } else {
      sqlite.prepare(
        'UPDATE duplicate_policy_actions SET status = ?, message = ?, updated_at = ? WHERE id = ?'
      ).run(status, message, new Date().toISOString(), id);
    }
  },
  getRun(runId: string, userId: string) {
    const row = sqlite.prepare(
      'SELECT * FROM duplicate_policy_runs WHERE id = ? AND user_id = ?'
    ).get(runId, userId) as RunRow | undefined;
    if (!row) return null;
    const actions = (sqlite.prepare(
      'SELECT * FROM duplicate_policy_actions WHERE run_id = ? ORDER BY group_key, position'
    ).all(runId) as ActionRow[]).map(mapAction);
    return mapRun(row, actions);
  },
  getLatestRun(userId: string, kind?: 'preview' | 'apply') {
    const row = (kind
      ? sqlite.prepare(
          'SELECT * FROM duplicate_policy_runs WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1'
        ).get(userId, kind)
      : sqlite.prepare(
          'SELECT * FROM duplicate_policy_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(userId)) as RunRow | undefined;
    if (!row) return null;
    const actions = (sqlite.prepare(
      'SELECT * FROM duplicate_policy_actions WHERE run_id = ? ORDER BY group_key, position'
    ).all(row.id) as ActionRow[]).map(mapAction);
    return mapRun(row, actions);
  },
  hasActiveApplyRun(userId: string) {
    return Boolean(
      sqlite
        .prepare(
          `SELECT 1 FROM duplicate_policy_runs
           WHERE user_id = ? AND kind = 'apply' AND status = 'running'
           LIMIT 1`
        )
        .get(userId)
    );
  },
  recoverInterruptedRuns() {
    const rows = sqlite.prepare(
      `SELECT DISTINCT user_id FROM duplicate_policy_runs
       WHERE kind = 'apply' AND status = 'running'`
    ).all() as Array<{ user_id: string }>;
    if (!rows.length) return [];
    const now = new Date().toISOString();
    sqlite.prepare(
      `UPDATE duplicate_policy_runs
       SET status = 'failed', error = 'Run interrupted by restart',
           updated_at = ?, completed_at = ?
       WHERE kind = 'apply' AND status = 'running'`
    ).run(now, now);
    return rows.map((row) => row.user_id);
  }
};
