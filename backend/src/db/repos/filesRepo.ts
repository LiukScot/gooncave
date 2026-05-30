import {
  deleteFile,
  findFileById,
  findFileByPath,
  listFavoriteFileIds,
  listFiles,
  listFilesBatch,
  listFilesPage,
  listFilesWithProviderRuns,
  listFilesWithoutProviderRun,
  setFileFavorite,
  upsertFile
} from './files/fileQueries';
import {
  createProviderRun,
  createProviderRunWithLimit,
  listProviderRuns,
  listProviderRunsByFileIds,
  removeProviderRunResultForFile,
  updateProviderRun
} from './files/providerRuns';
import { getSignaturesBatch, setSignature } from './files/signatures';
import {
  addManualTag,
  clearTagsForFile,
  listTagsForFile,
  removeManualTag,
  removeTagsBySourceUrl,
  replaceTagsForSource,
  saveManualOrder
} from './files/tags';

export const filesRepo = {
  listFilesPage,
  listFilesWithProviderRuns,
  upsertFile,
  listFiles,
  listFilesBatch,
  listFilesWithoutProviderRun,
  listFavoriteFileIds,
  setFileFavorite,
  findFileById,
  findFileByPath,
  deleteFile,
  listProviderRuns,
  listProviderRunsByFileIds,
  createProviderRunWithLimit,
  createProviderRun,
  updateProviderRun,
  listTagsForFile,
  clearTagsForFile,
  removeTagsBySourceUrl,
  replaceTagsForSource,
  addManualTag,
  removeManualTag,
  saveManualOrder,
  removeProviderRunResultForFile,
  getSignaturesBatch,
  setSignature
};
