import crypto from 'crypto';

import { tagDbRepo } from '../db/repos/tagDbRepo';
import type { FileRecord } from '../db/types';

import { refreshTagsForFile } from './tagging';

export type FileTagRefreshJob = {
  id: string;
  fileId: string;
  status: 'queued' | 'running' | 'done' | 'error';
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

const jobs = new Map<string, FileTagRefreshJob>();
const running = new Map<string, Promise<void>>();

const jobKey = (userId: string, fileId: string) => `${userId}:${fileId}`;

const updateJob = (
  key: string,
  patch: Partial<Pick<FileTagRefreshJob, 'status' | 'error'>>
) => {
  const current = jobs.get(key);
  if (!current) throw new Error('File tag refresh job disappeared');
  jobs.set(key, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
};

export const getFileTagRefreshJob = (
  userId: string,
  fileId: string,
  jobId: string
): FileTagRefreshJob | null => {
  const job = jobs.get(jobKey(userId, fileId));
  return job?.id === jobId ? job : null;
};

export const startFileTagRefresh = (
  userId: string,
  file: FileRecord
): { started: boolean; job: FileTagRefreshJob } => {
  const key = jobKey(userId, file.id);
  const current = jobs.get(key);
  if (current && running.has(key)) return { started: false, job: current };

  const now = new Date().toISOString();
  const job: FileTagRefreshJob = {
    id: crypto.randomUUID(),
    fileId: file.id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    error: null
  };
  jobs.set(key, job);

  const work = Promise.resolve().then(async () => {
    try {
      updateJob(key, { status: 'running', error: null });
      tagDbRepo.clearSuppressions(file.id);
      await refreshTagsForFile(file);
      updateJob(key, { status: 'done' });
    } catch {
      updateJob(key, {
        status: 'error',
        error: 'Tag refresh failed'
      });
    } finally {
      running.delete(key);
    }
  });
  running.set(key, work);
  return { started: true, job };
};
