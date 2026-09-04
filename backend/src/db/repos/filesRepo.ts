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
  listVotesByFileIds,
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
  listSourceTagTargets,
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
  listVotesByFileIds,
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
  listSourceTagTargets,
  removeTagsBySourceUrl,
  replaceTagsForSource,
  addManualTag,
  removeManualTag,
  removeProviderRunResultForFile,
  getSignaturesBatch,
  setSignature
};
