import fs from 'fs';
import path from 'path';

import { findDuplicates } from '../lib/duplicates';
import { dataStore, FavoriteProvider } from '../lib/dataStore';

const favoriteProviderPriority: FavoriteProvider[] = ['E621', 'DANBOORU'];

const resolveFavoriteRank = (providers: FavoriteProvider[]) => {
  let rank = 0;
  favoriteProviderPriority.forEach((provider, index) => {
    if (providers.includes(provider)) {
      rank = Math.max(rank, favoriteProviderPriority.length - index);
    }
  });
  return rank;
};

const resolveFavoriteOverlap = (a: FavoriteProvider[], b: FavoriteProvider[]) => {
  if (!a.length || !b.length) return true;
  return a.some((provider) => b.includes(provider));
};

const compareQuality = (a: { width: number | null; height: number | null; sizeBytes: number; path: string }, b: {
  width: number | null;
  height: number | null;
  sizeBytes: number;
  path: string;
}) => {
  const areaA = (a.width ?? 0) * (a.height ?? 0);
  const areaB = (b.width ?? 0) * (b.height ?? 0);
  if (areaA !== areaB) return areaB - areaA;
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.path.localeCompare(b.path);
};

const comparePreference = (
  a: { favoriteProviders: FavoriteProvider[]; width: number | null; height: number | null; sizeBytes: number; path: string },
  b: { favoriteProviders: FavoriteProvider[]; width: number | null; height: number | null; sizeBytes: number; path: string }
) => {
  const rankA = resolveFavoriteRank(a.favoriteProviders);
  const rankB = resolveFavoriteRank(b.favoriteProviders);
  if (rankA !== rankB) return rankB - rankA;
  return compareQuality(a, b);
};

const pickSuggestion = (a: { id: string; favoriteProviders: FavoriteProvider[] }, b: {
  id: string;
  favoriteProviders: FavoriteProvider[];
}) => {
  const conflict = a.favoriteProviders.length > 0 && b.favoriteProviders.length > 0 && !resolveFavoriteOverlap(a.favoriteProviders, b.favoriteProviders);
  if (conflict) {
    return { keepId: null as string | null };
  }
  const rankA = resolveFavoriteRank(a.favoriteProviders);
  const rankB = resolveFavoriteRank(b.favoriteProviders);
  if (rankA !== rankB) {
    return { keepId: rankA > rankB ? a.id : b.id };
  }
  return { keepId: a.id };
};

const deleteFileRecord = async (fileId: string) => {
  const file = await dataStore.findFileById(fileId);
  if (!file) return false;
  const folder = await dataStore.findFolderById(file.folderId);
  if (!folder || folder.type !== 'LOCAL') return false;
  const user = await dataStore.findUserByFileId(file.id);
  if (!user) return false;
  const favoriteItem = await dataStore.findFavoriteItemByPath(file.path, user.id);
  if (favoriteItem) return false;
  // Verify file path is within its folder root before deleting
  const resolvedBase = path.resolve(folder.path);
  const resolvedFile = path.resolve(file.path);
  if (!resolvedFile.startsWith(`${resolvedBase}${path.sep}`) && resolvedFile !== resolvedBase) return false;
  const errors: string[] = [];
  try {
    await fs.promises.unlink(resolvedFile);
  } catch (err) {
    errors.push((err as Error).message);
  }
  if (file.thumbPath) {
    try {
      await fs.promises.unlink(file.thumbPath);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (errors.length) return false;
  await dataStore.deleteFile(file.id);
  return true;
};

let autoResolveRunning = false;

export const autoResolveDuplicates = async () => {
  if (autoResolveRunning) return { status: 'busy' } as const;
  autoResolveRunning = true;
  try {
    const firstUser = (await dataStore.listUsers())[0];
    if (!firstUser) {
      return {
        status: 'done',
        deleted: 0,
        keptBoth: 0,
        skippedFavorites: 0,
        groups: 0
      } as const;
    }
    const result = await findDuplicates(firstUser.id);
    let keptBoth = 0;
    let deleted = 0;
    let skippedFavorites = 0;

    for (const group of result.groups) {
      if (group.files.length < 2) continue;
      const sorted = [...group.files].sort(comparePreference);
      const primary = sorted[0];
      for (const other of sorted.slice(1)) {
        const suggestion = pickSuggestion(primary, other);
        if (!suggestion.keepId) {
          keptBoth += 1;
          continue;
        }
        const discard = suggestion.keepId === primary.id ? other : primary;
        if (discard.favoriteProviders.length > 0) {
          skippedFavorites += 1;
          continue;
        }
        const ok = await deleteFileRecord(discard.id);
        if (ok) deleted += 1;
      }
    }

    return {
      status: 'done',
      deleted,
      keptBoth,
      skippedFavorites,
      groups: result.groups.length
    } as const;
  } finally {
    autoResolveRunning = false;
  }
};
