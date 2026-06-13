import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { argon2id, hash as argonHash, verify as argonVerify } from 'argon2';
import { FastifyReply } from 'fastify';

import { config } from '../config';
import { authRepo } from '../db/repos/authRepo';
import { foldersRepo } from '../db/repos/foldersRepo';
import type { UserRecord } from '../db/types';

import { chooseLibraryRoot, resolveStoredRoot } from './libraryRoot';

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
  if (password.length > 1024)
    throw new Error('Password exceeds maximum allowed length');
  return argonHash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4
  });
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
  return path.resolve(
    config.mediaPath,
    config.auth.usersRootDirName,
    directoryName
  );
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

const ensureUserRootFolderRecord = async (
  userId: string,
  previousRoot: string,
  nextRoot: string
) => {
  const existingNextFolder = await foldersRepo.findFolderByPath(
    nextRoot,
    userId
  );
  if (existingNextFolder) return;

  const previousFolder =
    previousRoot === nextRoot
      ? null
      : await foldersRepo.findFolderByPath(previousRoot, userId);
  if (previousFolder) {
    await foldersRepo.updateFolder(previousFolder.id, { path: nextRoot });
    return;
  }

  await foldersRepo.addFolder(nextRoot, userId);
};

const syncUserLibraryRoot = async (user: UserRecord) => {
  const storedRoot = resolveStoredRoot(user.libraryRoot);
  const preferredRoot = buildUserLibraryRoot(user.username, user.id);

  const storedExists = storedRoot ? await pathExists(storedRoot) : false;
  const storedHasEntries =
    storedRoot && storedExists ? await directoryHasEntries(storedRoot) : false;
  const preferredExists =
    storedRoot === preferredRoot
      ? storedExists
      : await pathExists(preferredRoot);

  const effectiveRoot = chooseLibraryRoot({
    storedRoot,
    preferredRoot,
    storedExists,
    storedHasEntries,
    preferredExists
  });

  await fs.promises.mkdir(effectiveRoot, { recursive: true });
  await ensureUserRootFolderRecord(
    user.id,
    storedRoot ?? effectiveRoot,
    effectiveRoot
  );

  if (effectiveRoot === storedRoot) {
    return user;
  }

  await authRepo.setUserLibraryRoot(user.id, effectiveRoot);
  const updatedUser = await authRepo.findUserById(user.id);
  if (!updatedUser) {
    throw new Error(`Failed to reload user ${user.id} after library root sync`);
  }
  return updatedUser;
};
export const isPathInside = (candidatePath: string, basePath: string) => {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  return (
    resolvedCandidate === resolvedBase ||
    resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)
  );
};

export const resolveUserManagedPath = async (
  libraryRoot: string,
  rawPath: string
) => {
  const requested = rawPath.trim();
  const resolvedRoot = await fs.promises
    .realpath(libraryRoot)
    .catch(() => path.resolve(libraryRoot));
  const initial = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(resolvedRoot, requested);
  const resolvedCandidate = await fs.promises
    .realpath(initial)
    .catch(() => initial);
  if (!isPathInside(resolvedCandidate, resolvedRoot)) {
    throw new Error('Folder path must stay inside your library root');
  }
  return resolvedCandidate;
};

export const createSessionToken = () => randomBytes(32).toString('hex');

export const setSessionCookie = (
  reply: FastifyReply,
  token: string,
  expiresAt: string
) => {
  reply.setCookie(sessionCookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.auth.cookieSecure,
    expires: new Date(expiresAt)
  });
};

export const clearSessionCookie = (reply: FastifyReply) => {
  reply.clearCookie(sessionCookieName, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.auth.cookieSecure
  });
};

export const createSessionForUser = async (userId: string) => {
  await authRepo.deleteExpiredSessions();
  const token = createSessionToken();
  const expiresAt = new Date(
    Date.now() + config.auth.sessionTtlMs
  ).toISOString();
  const session = await authRepo.createSession(userId, token, expiresAt);
  await authRepo.updateUserLastLogin(userId);
  return session;
};

export const getUserFromSessionToken = async (token: string) => {
  await authRepo.deleteExpiredSessions();
  const session = await authRepo.findSessionByToken(token);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await authRepo.deleteSessionByToken(token);
    return null;
  }
  const user = await authRepo.findUserById(session.userId);
  if (!user) return null;
  const syncedUser = await syncUserLibraryRoot(user);
  return toAuthenticatedUser(syncedUser);
};

export const registerLocalUser = async (username: string, password: string) => {
  const normalizedUsername = username.trim();
  const existing = await authRepo.findUserByUsername(normalizedUsername);
  if (existing) {
    throw new Error('Username already exists');
  }
  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const libraryRoot = buildUserLibraryRoot(normalizedUsername, userId);
  await fs.promises.mkdir(libraryRoot, { recursive: true });
  let user: UserRecord | null = null;
  try {
    user = await authRepo.createUser({
      id: userId,
      username: normalizedUsername,
      passwordHash,
      libraryRoot
    });
    const rootFolder = await foldersRepo.findFolderByPath(libraryRoot, user.id);
    if (!rootFolder) {
      await foldersRepo.addFolder(libraryRoot, user.id);
    }
  } catch (error) {
    if (user) {
      await authRepo.deleteUserById(user.id);
    }
    throw error;
  }
  const created = await authRepo.findUserById(userId);
  if (!created) {
    throw new Error('Failed to reload created user');
  }
  return created;
};

export const loginLocalUser = async (username: string, password: string) => {
  const user = await authRepo.findUserByUsername(username.trim());
  if (!user) {
    throw new Error('Invalid username or password');
  }
  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    throw new Error('Invalid username or password');
  }
  return syncUserLibraryRoot(user);
};
