import { randomUUID } from 'crypto';

import type {
  CredentialProvider,
  CredentialRecord,
  SessionRecord,
  UserRecord
} from '../../db/types';
import { sqlite } from '../client';

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  library_root: string;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  token: string;
  created_at: string;
  expires_at: string;
};

type CredentialRow = {
  user_id?: string;
  provider: CredentialProvider;
  username?: string | null;
  api_key?: string | null;
  updated_at: string;
};

const mapUserRow = (row: UserRow): UserRecord => ({
  id: row.id,
  username: row.username,
  passwordHash: row.password_hash,
  libraryRoot: row.library_root,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastLoginAt: row.last_login_at ?? null
});

const mapSessionRow = (row: SessionRow): SessionRecord => ({
  id: row.id,
  userId: row.user_id,
  token: row.token,
  createdAt: row.created_at,
  expiresAt: row.expires_at
});

const mapCredentialRow = (row: CredentialRow): CredentialRecord => ({
  provider: row.provider,
  username: row.username ?? null,
  apiKey: row.api_key ?? null,
  updatedAt: row.updated_at
});

export const authRepo = {
  async countUsers() {
    const row = sqlite.prepare('SELECT COUNT(*) AS count FROM users').get() as
      { count?: number } | undefined;
    return Number(row?.count ?? 0);
  },
  async listUsers() {
    const rows = sqlite
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all() as UserRow[];
    return rows.map(mapUserRow);
  },
  async findUserById(id: string) {
    const row = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      UserRow | undefined;
    return row ? mapUserRow(row) : null;
  },
  async findUserByUsername(username: string) {
    const row = sqlite
      .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)')
      .get(username) as UserRow | undefined;
    return row ? mapUserRow(row) : null;
  },
  async findUserByFolderId(folderId: string) {
    const row = sqlite
      .prepare(
        `SELECT u.*
         FROM users u
         JOIN folders f ON f.user_id = u.id
         WHERE f.id = ?`
      )
      .get(folderId) as UserRow | undefined;
    return row ? mapUserRow(row) : null;
  },
  async findUserByFileId(fileId: string) {
    const row = sqlite
      .prepare(
        `SELECT u.*
         FROM users u
         JOIN folders f ON f.user_id = u.id
         JOIN files fi ON fi.folder_id = f.id
         WHERE fi.id = ?`
      )
      .get(fileId) as UserRow | undefined;
    return row ? mapUserRow(row) : null;
  },
  async findUsersByFileIds(fileIds: string[]) {
    const owners = new Map<string, UserRecord>();
    if (fileIds.length === 0) return owners;
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT fi.id AS file_id, u.*
         FROM files fi
         JOIN folders f ON f.id = fi.folder_id
         JOIN users u ON u.id = f.user_id
         WHERE fi.id IN (${placeholders})`
      )
      .all(...fileIds) as Array<UserRow & { file_id: string }>;
    for (const row of rows) {
      owners.set(row.file_id, mapUserRow(row));
    }
    return owners;
  },
  async createUser(input: {
    id?: string;
    username: string;
    passwordHash: string;
    libraryRoot: string;
  }) {
    const now = new Date().toISOString();
    const user: UserRecord = {
      id: input.id ?? randomUUID(),
      username: input.username,
      passwordHash: input.passwordHash,
      libraryRoot: input.libraryRoot,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null
    };
    sqlite
      .prepare(
        `INSERT INTO users (id, username, password_hash, library_root, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        user.id,
        user.username,
        user.passwordHash,
        user.libraryRoot,
        user.createdAt,
        user.updatedAt,
        user.lastLoginAt
      );
    return user;
  },
  async setUserLibraryRoot(userId: string, libraryRoot: string) {
    const now = new Date().toISOString();
    sqlite
      .prepare('UPDATE users SET library_root = ?, updated_at = ? WHERE id = ?')
      .run(libraryRoot, now, userId);
  },
  async updateUserLastLogin(userId: string) {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        'UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?'
      )
      .run(now, now, userId);
  },
  async deleteUserById(userId: string) {
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId);
  },
  async createSession(userId: string, token: string, expiresAt: string) {
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      token,
      createdAt: new Date().toISOString(),
      expiresAt
    };
    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, token, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.userId,
        session.token,
        session.createdAt,
        session.expiresAt
      );
    return session;
  },
  async findSessionByToken(token: string) {
    const row = sqlite
      .prepare('SELECT * FROM sessions WHERE token = ?')
      .get(token) as SessionRow | undefined;
    return row ? mapSessionRow(row) : null;
  },
  async deleteSessionByToken(token: string) {
    sqlite.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },
  async deleteExpiredSessions() {
    sqlite
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(new Date().toISOString());
  },
  async getCredential(provider: CredentialProvider, userId: string) {
    const row = sqlite
      .prepare(
        'SELECT * FROM provider_credentials WHERE provider = ? AND user_id = ?'
      )
      .get(provider, userId) as CredentialRow | undefined;
    return row ? mapCredentialRow(row) : null;
  },
  async listCredentials(userId: string) {
    const rows = sqlite
      .prepare('SELECT * FROM provider_credentials WHERE user_id = ?')
      .all(userId) as CredentialRow[];
    return rows.map(mapCredentialRow);
  },
  async listLegacyBooruCredentialsMissingSites(
    providers: CredentialProvider[]
  ) {
    if (providers.length === 0)
      return [] as Array<CredentialRecord & { userId: string }>;
    const placeholders = providers.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT pc.user_id, pc.provider, pc.username, pc.api_key, pc.updated_at
         FROM provider_credentials pc
         LEFT JOIN user_booru_sites ubs
           ON ubs.user_id = pc.user_id
          AND ubs.preset_key = pc.provider
         WHERE pc.provider IN (${placeholders})
           AND ubs.id IS NULL
         ORDER BY pc.user_id ASC, pc.provider ASC`
      )
      .all(...providers) as Array<CredentialRow & { user_id: string }>;
    return rows.map((row) => ({
      userId: row.user_id,
      ...mapCredentialRow(row)
    }));
  },
  /**
   * Legacy credentials whose preset site row exists but carries no API key.
   *
   * The seed below only ever created missing rows, so an account that added
   * the site by hand before the migration — or added it without a key — kept
   * its key stranded in provider_credentials, where nothing reads it. The
   * site then looks configured while every authenticated call is refused.
   */
  async listLegacyBooruKeysForSitesMissingKey(providers: CredentialProvider[]) {
    if (providers.length === 0) {
      return [] as Array<{
        siteId: string;
        userId: string;
        provider: CredentialProvider;
        apiKey: string;
        username: string | null;
      }>;
    }
    const placeholders = providers.map(() => '?').join(',');
    const rows = sqlite
      .prepare(
        `SELECT ubs.id AS site_id, pc.user_id, pc.provider, pc.api_key, pc.username
         FROM provider_credentials pc
         JOIN user_booru_sites ubs
           ON ubs.user_id = pc.user_id
          AND ubs.preset_key = pc.provider
         WHERE pc.provider IN (${placeholders})
           AND pc.api_key IS NOT NULL
           AND pc.api_key != ''
           AND (ubs.api_key IS NULL OR ubs.api_key = '')`
      )
      .all(...providers) as Array<{
      site_id: string;
      user_id: string;
      provider: CredentialProvider;
      api_key: string;
      username: string | null;
    }>;
    return rows.map((row) => ({
      siteId: row.site_id,
      userId: row.user_id,
      provider: row.provider,
      apiKey: row.api_key,
      username: row.username
    }));
  },
  /**
   * Blanks the api_key on a legacy credential row once it has been copied
   * onto its booru site.
   *
   * Without this the copy is not a migration but a permanent mirror: nothing
   * else ever clears provider_credentials (only deleting the whole site
   * does), so a user who clears their key from the UI would have it copied
   * back on the next restart, with no way to make the clear stick. The
   * username is left in place — it is not a secret and costs nothing.
   */
  async clearLegacyCredentialKey(
    provider: CredentialProvider,
    userId: string
  ): Promise<void> {
    sqlite
      .prepare(
        `UPDATE provider_credentials SET api_key = NULL, updated_at = ?
         WHERE provider = ? AND user_id = ?`
      )
      .run(new Date().toISOString(), provider, userId);
  },
  async upsertCredential(
    provider: CredentialProvider,
    updates: { username?: string; apiKey?: string },
    userId: string
  ) {
    const tx = sqlite.transaction(() => {
      const existingRow = sqlite
        .prepare(
          'SELECT * FROM provider_credentials WHERE provider = ? AND user_id = ?'
        )
        .get(provider, userId) as CredentialRow | undefined;
      const existing = existingRow ? mapCredentialRow(existingRow) : null;
      const nextUsername =
        provider === 'SAUCENAO'
          ? null
          : updates.username !== undefined
            ? updates.username.trim() || null
            : (existing?.username ?? null);
      const nextApiKey =
        updates.apiKey !== undefined
          ? updates.apiKey.trim() || null
          : (existing?.apiKey ?? null);
      if (!nextUsername && provider !== 'SAUCENAO' && !nextApiKey) {
        sqlite
          .prepare(
            'DELETE FROM provider_credentials WHERE provider = ? AND user_id = ?'
          )
          .run(provider, userId);
        return null;
      }
      if (provider === 'SAUCENAO' && !nextApiKey) {
        sqlite
          .prepare(
            'DELETE FROM provider_credentials WHERE provider = ? AND user_id = ?'
          )
          .run(provider, userId);
        return null;
      }
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO provider_credentials (user_id, provider, username, api_key, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, provider)
           DO UPDATE SET username = excluded.username, api_key = excluded.api_key, updated_at = excluded.updated_at`
        )
        .run(userId, provider, nextUsername, nextApiKey, now);
      return {
        provider,
        username: nextUsername,
        apiKey: nextApiKey,
        updatedAt: now
      } as CredentialRecord;
    });
    return tx();
  }
};
