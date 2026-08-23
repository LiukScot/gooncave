import {
  applyFileVote,
  deleteFile,
  findFileById,
  findFileByPath,
  listFiles,
  listFilesBatch,
  listFilesPage,
  listFilesWithProviderRuns,
  listFilesWithoutProviderRun,
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
  replaceTagsForSource
} from './files/tags';

export const filesRepo = {
  listFilesPage,
  listFilesWithProviderRuns,
  upsertFile,
  listFiles,
  listFilesBatch,
  listFilesWithoutProviderRun,
  applyFileVote,
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
  removeProviderRunResultForFile,
  getSignaturesBatch,
  setSignature
};
