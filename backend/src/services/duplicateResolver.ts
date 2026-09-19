import fs from 'fs';
import path from 'path';

import { config } from '../config';
import { favoritesRepo } from '../db/repos/favoritesRepo';
import { filesRepo } from '../db/repos/filesRepo';
import { foldersRepo } from '../db/repos/foldersRepo';

const isPathInsideRoot = (candidate: string, root: string) => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
};

export const deleteFileRecord = async (fileId: string, userId: string) => {
  const file = await filesRepo.findFileById(fileId, userId);
  if (!file) return false;
  const folder = await foldersRepo.findFolderById(file.folderId, userId);
  if (!folder || folder.type !== 'LOCAL') return false;
  const favoriteItems = await favoritesRepo.listFavoriteItemsByPath(
    file.path,
    userId
  );
  if (favoriteItems.length > 0) return false;
  // Verify file path is within its folder root before deleting
  const resolvedBase = path.resolve(folder.path);
  const resolvedFile = path.resolve(file.path);
  if (
    !resolvedFile.startsWith(`${resolvedBase}${path.sep}`) &&
    resolvedFile !== resolvedBase
  )
    return false;
  const errors: string[] = [];
  try {
    await fs.promises.unlink(resolvedFile);
  } catch (err) {
    errors.push((err as Error).message);
  }
  // The surviving duplicate is byte-identical and so shares this thumbnail
  // (named from the content hash): removing it here would blank its tile.
  if (file.thumbPath && !filesRepo.isThumbPathShared(file.thumbPath, file.id)) {
    // A corrupted/forged thumbPath in the DB must never escape the configured
    // thumbnails dir — otherwise unlink could delete arbitrary files. Resolve
    // the real path and confirm containment before touching the FS. Skip (not
    // throw) so one bad record can't abort the whole auto-resolve batch.
    const resolvedThumb = path.resolve(file.thumbPath);
    if (!isPathInsideRoot(resolvedThumb, config.storage.thumbnailsDir)) {
      errors.push(`thumbPath outside thumbnails dir: ${file.id}`);
    } else {
      try {
        await fs.promises.unlink(resolvedThumb);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  if (errors.length) return false;
  await filesRepo.deleteFile(file.id);
  return true;
};
