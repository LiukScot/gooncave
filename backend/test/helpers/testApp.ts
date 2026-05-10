// IMPORTANT: setupEnv MUST be the first import in this file. It mutates
// process.env to redirect SQLite to `:memory:` and tmp dirs, and that has
// to happen before `src/config.ts` is loaded by any downstream import.
import './setupEnv';

import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { FastifyInstance } from 'fastify';

import { createServer } from '../../src/index';
import { dataStore } from '../../src/lib/dataStore';
import type { ScannedFile } from '../../src/lib/scanner';
import { createSessionForUser, hashPassword } from '../../src/services/auth';

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = createServer();
  await app.ready();
  return app;
};

export const seedUser = async (overrides: { username?: string; password?: string } = {}) => {
  const username = overrides.username ?? `user_${randomUUID().slice(0, 8)}`;
  const password = overrides.password ?? 'correct horse battery staple';
  const passwordHash = await hashPassword(password);
  const tmpRoot = process.env.GOONCAVE_TEST_TMP_ROOT ?? os.tmpdir();
  const libraryRoot = path.join(tmpRoot, 'library', username);
  fs.mkdirSync(libraryRoot, { recursive: true });
  const user = await dataStore.createUser({ username, passwordHash, libraryRoot });
  await dataStore.addFolder(libraryRoot, user.id);
  return { user, username, password, libraryRoot };
};

export const sessionCookieFor = async (userId: string) => {
  const session = await createSessionForUser(userId);
  return { name: 'gooncave_session', value: session.token, expiresAt: session.expiresAt };
};

export const writeFixtureFile = (dirAbs: string, name: string, contents: Buffer | string) => {
  fs.mkdirSync(dirAbs, { recursive: true });
  const filePath = path.join(dirAbs, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
};

export const registerFixtureFile = async (
  folderId: string,
  filePath: string,
  options: Partial<Pick<ScannedFile, 'mediaType' | 'width' | 'height'>> = {}
) => {
  const stat = fs.statSync(filePath);
  return dataStore.upsertFile(folderId, {
    locationType: 'LOCAL',
    path: filePath,
    sizeBytes: BigInt(stat.size),
    mtime: stat.mtime,
    sha256: randomUUID().replace(/-/g, ''),
    mediaType: options.mediaType ?? 'IMAGE',
    width: options.width ?? 100,
    height: options.height ?? 100,
    durationMs: null,
    phash: null,
    thumbPath: null
  });
};
