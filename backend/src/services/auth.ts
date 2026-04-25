import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { argon2id, hash as argonHash, verify as argonVerify } from 'argon2';
import { FastifyReply } from 'fastify';

import { config } from '../config';
import { dataStore, UserRecord } from '../lib/dataStore';

export type AuthenticatedUser = Omit<UserRecord, 'passwordHash'>;

const sessionCookieName = config.auth.cookieName;

const toAuthenticatedUser = (user: UserRecord): AuthenticatedUser => ({
  id: user.id,
  username: user.username,
  libraryRoot: user.libraryRoot,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  lastLoginAt: user.lastLoginAt
});

export const toPublicUser = (user: UserRecord | AuthenticatedUser) => ({
  id: user.id,
  username: user.username,
  libraryRoot: user.libraryRoot,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  lastLoginAt: user.lastLoginAt
});

export const hashPassword = async (password: string) => {
  return argonHash(password, { type: argon2id });
};

export const verifyPassword = async (hash: string, password: string) => {
  return argonVerify(hash, password);
};

const buildUserDirectorySuffix = (userId: string) => {
  const compactId = userId.replace(/-/g, '');
  const numericValue = Number.parseInt(compactId.slice(0, 12), 16);
  return (numericValue % 1_000_000).toString().padStart(6, '0');
};

export const buildUserLibraryRoot = (username: string, userId: string) => {
  const directoryName = `${username}-${buildUserDirectorySuffix(userId)}`;
  return path.resolve(config.mediaPath, config.auth.usersRootDirName, directoryName);
};

const pathExists = async (candidatePath: string) => {
  try {
    await fs.promises.access(candidatePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const directoryHasEntries = async (candidatePath: string) => {
  try {
    const entries = await fs.promises.readdir(candidatePath);
    return entries.length > 0;
  } catch {
    return false;
  }
};

const ensureUserRootFolderRecord = async (userId: string, previousRoot: string, nextRoot: string) => {
  const existingNextFolder = await dataStore.findFolderByPath(nextRoot, userId);
  if (existingNextFolder) return;

  const previousFolder = previousRoot === nextRoot ? null : await dataStore.findFolderByPath(previousRoot, userId);
  if (previousFolder) {
    await dataStore.updateFolder(previousFolder.id, { path: nextRoot }, userId);
    return;
  }

  await dataStore.addFolder(nextRoot, userId);
};

const syncUserLibraryRoot = async (user: UserRecord) => {
  const storedRoot = path.resolve(user.libraryRoot);
  const preferredRoot = buildUserLibraryRoot(user.username, user.id);

  const storedExists = await pathExists(storedRoot);
  const storedHasEntries = storedExists ? await directoryHasEntries(storedRoot) : false;
  const preferredExists = preferredRoot === storedRoot ? storedExists : await pathExists(preferredRoot);

  let effectiveRoot = storedRoot;
  if (storedRoot !== preferredRoot && preferredExists && (!storedExists || !storedHasEntries)) {
    effectiveRoot = preferredRoot;
  } else if (storedExists) {
    effectiveRoot = storedRoot;
  } else if (preferredExists) {
    effectiveRoot = preferredRoot;
  } else {
    effectiveRoot = preferredRoot;
  }

  await fs.promises.mkdir(effectiveRoot, { recursive: true });
  await ensureUserRootFolderRecord(user.id, storedRoot, effectiveRoot);

  if (effectiveRoot === storedRoot) {
    return user;
  }

  await dataStore.setUserLibraryRoot(user.id, effectiveRoot);
  return (await dataStore.findUserById(user.id)) ?? { ...user, libraryRoot: effectiveRoot };
};
export const isPathInside = (candidatePath: string, basePath: string) => {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
};

export const resolveUserManagedPath = async (libraryRoot: string, rawPath: string) => {
  const requested = rawPath.trim();
  const resolvedRoot = await fs.promises.realpath(libraryRoot).catch(() => path.resolve(libraryRoot));
  const initial = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(resolvedRoot, requested);
  const resolvedCandidate = await fs.promises.realpath(initial).catch(() => initial);
  if (!isPathInside(resolvedCandidate, resolvedRoot)) {
    throw new Error('Folder path must stay inside your library root');
  }
  return resolvedCandidate;
};

export const createSessionToken = () => randomBytes(32).toString('hex');

export const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: string) => {
  reply.setCookie(sessionCookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    expires: new Date(expiresAt)
  });
};

export const clearSessionCookie = (reply: FastifyReply) => {
  reply.clearCookie(sessionCookieName, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: false
  });
};

export const createSessionForUser = async (userId: string) => {
  await dataStore.deleteExpiredSessions();
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + config.auth.sessionTtlMs).toISOString();
  const session = await dataStore.createSession(userId, token, expiresAt);
  await dataStore.updateUserLastLogin(userId);
  return session;
};

export const getUserFromSessionToken = async (token: string) => {
  await dataStore.deleteExpiredSessions();
  const session = await dataStore.findSessionByToken(token);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await dataStore.deleteSessionByToken(token);
    return null;
  }
  const user = await dataStore.findUserById(session.userId);
  if (!user) return null;
  const syncedUser = await syncUserLibraryRoot(user);
  return toAuthenticatedUser(syncedUser);
};

export const registerLocalUser = async (username: string, password: string) => {
  const normalizedUsername = username.trim();
  const existing = await dataStore.findUserByUsername(normalizedUsername);
  if (existing) {
    throw new Error('Username already exists');
  }
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const libraryRoot = buildUserLibraryRoot(normalizedUsername, userId);
  await fs.promises.mkdir(libraryRoot, { recursive: true });
  const user = await dataStore.createUser({
    id: userId,
    username: normalizedUsername,
    passwordHash,
    libraryRoot
  });
  const rootFolder = await dataStore.findFolderByPath(libraryRoot, user.id);
  if (!rootFolder) {
    await dataStore.addFolder(libraryRoot, user.id);
  }
  const created = await dataStore.findUserById(user.id);
  if (!created) {
    throw new Error('Failed to reload created user');
  }
  return created;
};

export const loginLocalUser = async (username: string, password: string) => {
  const user = await dataStore.findUserByUsername(username.trim());
  if (!user) {
    throw new Error('Invalid username or password');
  }
  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    throw new Error('Invalid username or password');
  }
  return syncUserLibraryRoot(user);
};
