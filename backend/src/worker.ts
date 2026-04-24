import fs from 'fs';
import path from 'path';

import chokidar from 'chokidar';
import { fetch } from 'undici';

import { config } from './config';
import { dataStore, FileRecord, FolderRecord, ProviderRunRecord } from './lib/dataStore';
import { executeProviderRun, ProviderKind } from './lib/providerRunner';
import { hasTargetSauce, normalizeSauceKey } from './lib/sauces';
import { startFavoritesSync } from './services/favorites';
import { ensureWd14Tags } from './services/tagging';
import { iterateLocalMediaPaths, scanFolder, scanLocalFile, ScannedFile } from './lib/scanner';

const providerKinds: ProviderKind[] = ['SAUCENAO', 'FLUFFLE'];
const dayMs = 24 * 60 * 60 * 1000;
const providerRefreshIntervalMs = dayMs;
const providerRefreshBatchSize = 5;
const providerRefreshScanBatchSize = 100;
const providerRunsPerScanLimit = 6;
const missingProviderMinMs = 10 * 60 * 1000;
const missingProviderMaxMs = 20 * 60 * 1000;
const missingProviderCandidateLimit = 25;
const providerRefreshMaxDays = 7;
const favoritesSyncIntervalMs = config.favorites.syncIntervalMs;
const wd14BackfillIntervalMs = config.wd14.backfillIntervalHours * 60 * 60 * 1000;
const wd14BackfillBatchSize = 50;
const folderRefreshIntervalMs = 60 * 1000;
const localRescanIntervalMs = config.background.localRescanIntervalMs;
const folderPollIntervalMs = 10 * 1000;
const scanIdleTimeoutMs = 30 * 1000;
const scanFileTimeoutMs = 30 * 1000;
const scanFileRetryDelayMs = 10 * 1000;
const scanFileRetryLimit = 2;

const watchers = new Map<string, chokidar.FSWatcher>();
const scanStates = new Map<string, ScanState>();
const folderMtimeCache = new Map<string, number>();
let providerRefreshRunning = false;
let missingProviderRunning = false;
let missingProviderTimer: NodeJS.Timeout | null = null;
let favoritesSyncTimer: NodeJS.Timeout | null = null;
let favoritesSyncInterval: NodeJS.Timeout | null = null;
let wd14BackfillTimer: NodeJS.Timeout | null = null;
let wd14BackfillRunning = false;

type ScanState = {
  folderId: string;
  running: boolean;
  needsFullScan: boolean;
  pendingPaths: Set<string>;
  pendingDeletes: Set<string>;
  wake?: () => void;
  scanId?: string;
  existingByPath?: Map<string, FileRecord>;
  managedChildRoots: string[];
  providerRunsStarted: number;
  retryCounts: Map<string, number>;
  lastMutationAt: number;
};

const runProviderAsync = (file: FileRecord, provider: ProviderKind) => {
  void executeProviderRun(file, provider).catch((err) => {
    console.warn(`[provider] ${provider} failed for ${file.id}: ${(err as Error).message}`);
  });
};

const runWd14Async = (file: FileRecord) => {
  if (file.mediaType === 'VIDEO') {
    void ensureWd14Tags(file, true).catch((err) => {
      console.warn(`[tags] wd14 failed for ${file.id}: ${(err as Error).message}`);
    });
    return;
  }
  if (file.mediaType === 'IMAGE') {
    void ensureWd14Tags(file, false, { ignoreSourceTags: true }).catch((err) => {
      console.warn(`[tags] wd14 failed for ${file.id}: ${(err as Error).message}`);
    });
  }
};

const isProviderDue = (
  runs: ProviderRunRecord[] | undefined,
  provider: ProviderKind,
  nowMs: number,
  targetKeys: Set<string>
) => {
  const allRuns = runs ?? [];
  if (allRuns.some((run) => run.status === 'RUNNING' || run.status === 'PENDING')) {
    return false;
  }
  if (allRuns.length === 0) return false;

  let firstRunMs = Number.POSITIVE_INFINITY;
  let lastProviderRunMs = 0;
  for (const run of allRuns) {
    const ts = new Date(run.completedAt ?? run.createdAt).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts < firstRunMs) firstRunMs = ts;
    if (run.provider === provider && ts > lastProviderRunMs) {
      lastProviderRunMs = ts;
    }
  }

  if (!Number.isFinite(firstRunMs)) return false;
  if (nowMs - firstRunMs > providerRefreshMaxDays * dayMs) return false;
  if (targetKeys.size > 0 && hasTargetSauce(allRuns, targetKeys)) return false;
  if (!lastProviderRunMs) return false;
  return nowMs - lastProviderRunMs >= dayMs;
};

const shuffle = <T>(items: T[]) => {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
};

const getScanState = (folderId: string): ScanState => {
  const existing = scanStates.get(folderId);
  if (existing) return existing;
  const state: ScanState = {
    folderId,
    running: false,
    needsFullScan: false,
    pendingPaths: new Set(),
    pendingDeletes: new Set(),
    managedChildRoots: [],
    providerRunsStarted: 0,
    retryCounts: new Map(),
    lastMutationAt: 0
  };
  scanStates.set(folderId, state);
  return state;
};

const isSameOrInsidePath = (candidatePath: string, basePath: string) => {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
};

const listManagedChildRoots = async (folder: FolderRecord) => {
  const folders = await dataStore.listFolders(folder.userId ?? undefined);
  return folders
    .filter((candidate) => {
      if (candidate.id === folder.id || candidate.type !== 'LOCAL') return false;
      return isSameOrInsidePath(candidate.path, folder.path);
    })
    .map((candidate) => path.resolve(candidate.path))
    .sort((left, right) => left.length - right.length);
};

const isManagedChildPath = (filePath: string, managedChildRoots: string[]) => {
  return managedChildRoots.some((childRoot) => {
    return isSameOrInsidePath(filePath, childRoot);
  });
};

const deleteExistingPathFromFolder = async (filePath: string, state: ScanState) => {
  const existing = state.existingByPath?.get(filePath);
  if (!existing) return false;
  await dataStore.deleteFile(existing.id);
  state.existingByPath?.delete(filePath);
  state.lastMutationAt = Date.now();
  return true;
};

class ScanTimeoutError extends Error {
  constructor(label: string) {
    super(`Scan timeout: ${label}`);
    this.name = 'ScanTimeoutError';
  }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new ScanTimeoutError(label)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const wakeScan = (state: ScanState) => {
  if (!state.wake) return;
  const wake = state.wake;
  state.wake = undefined;
  wake();
};

const queueFullScan = (folderId: string, reason: string) => {
  const state = getScanState(folderId);
  state.needsFullScan = true;
  wakeScan(state);
  void startScanSession(folderId, reason);
};

const queuePathScan = (folderId: string, filePath: string, reason: string) => {
  const state = getScanState(folderId);
  state.pendingPaths.add(filePath);
  wakeScan(state);
  void startScanSession(folderId, reason);
};

const queueDelete = (folderId: string, filePath: string, reason: string) => {
  const state = getScanState(folderId);
  state.pendingDeletes.add(filePath);
  wakeScan(state);
  void startScanSession(folderId, reason);
};

const shouldIgnoreWatchedPath = (folderId: string, filePath: string) => {
  const state = getScanState(folderId);
  if (state.managedChildRoots.length === 0) return false;
  return isManagedChildPath(filePath, state.managedChildRoots);
};

const waitForPendingOrTimeout = (state: ScanState) => {
  return new Promise<'pending' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => {
      state.wake = undefined;
      resolve('timeout');
    }, scanIdleTimeoutMs);
    state.wake = () => {
      clearTimeout(timer);
      state.wake = undefined;
      resolve('pending');
    };
  });
};

const handleUpsertedFile = async (folderId: string, scanned: ScannedFile, state: ScanState) => {
  const previous = state.existingByPath?.get(scanned.path);
  if (previous) {
    const sameSize = Number(previous.sizeBytes) === Number(scanned.sizeBytes);
    const sameSha = previous.sha256 === scanned.sha256;
    const sameMtime = new Date(previous.mtime).getTime() === scanned.mtime.getTime();
    if (sameSize && sameSha && sameMtime) {
      return;
    }
  }

  const saved = await dataStore.upsertFile(folderId, scanned);
  state.existingByPath?.set(saved.path, saved);
  state.lastMutationAt = Date.now();
  const changed = !!previous && (previous.sha256 !== saved.sha256 || previous.mtime !== saved.mtime);
  const needsProviderScan = !previous || changed;

  if (needsProviderScan && state.providerRunsStarted < providerRunsPerScanLimit) {
    for (const provider of providerKinds) {
      if (state.providerRunsStarted >= providerRunsPerScanLimit) break;
      runProviderAsync(saved, provider);
      state.providerRunsStarted += 1;
    }
  }

  runWd14Async(saved);
};

const processLocalFile = async (folderId: string, filePath: string, state: ScanState) => {
  if (isManagedChildPath(filePath, state.managedChildRoots)) {
    await deleteExistingPathFromFolder(filePath, state);
    return;
  }

  let file: ScannedFile | null = null;
  try {
    file = await withTimeout(
      scanLocalFile(filePath, {
        thumbnailsDir: config.storage.thumbnailsDir,
        existingFiles: state.existingByPath
      }),
      scanFileTimeoutMs,
      filePath
    );
  } catch (err) {
    if (err instanceof ScanTimeoutError) {
      const retries = state.retryCounts.get(filePath) ?? 0;
      if (retries < scanFileRetryLimit) {
        state.retryCounts.set(filePath, retries + 1);
        setTimeout(() => queuePathScan(folderId, filePath, 'retry-timeout'), scanFileRetryDelayMs);
      } else {
        state.retryCounts.delete(filePath);
      }
      console.warn(`[scan] timeout ${filePath}: ${(err as Error).message}`);
    } else {
      console.warn(`[scan] skipped ${filePath}: ${(err as Error).message}`);
    }
  }

  if (!file) return;
  await handleUpsertedFile(folderId, file, state);
};

const drainPendingDeletes = async (folderId: string, state: ScanState) => {
  if (state.pendingDeletes.size === 0) return;
  const pending = Array.from(state.pendingDeletes);
  state.pendingDeletes.clear();
  const existingByPath = state.existingByPath ?? new Map();
  state.existingByPath = existingByPath;

  for (const filePath of pending) {
    const existing = existingByPath.get(filePath);
    if (!existing) continue;
    await dataStore.deleteFile(existing.id);
    existingByPath.delete(filePath);
    state.lastMutationAt = Date.now();
  }
};

const drainPendingPaths = async (folderId: string, state: ScanState) => {
  while (state.pendingPaths.size > 0) {
    const filePath = state.pendingPaths.values().next().value as string;
    state.pendingPaths.delete(filePath);
    await processLocalFile(folderId, filePath, state);
  }
};

const runFullLocalScan = async (folder: FolderRecord, state: ScanState) => {
  state.managedChildRoots = await listManagedChildRoots(folder);
  const existingByPath = state.existingByPath ?? new Map();
  state.existingByPath = existingByPath;

  for (const [filePath, existing] of Array.from(existingByPath.entries())) {
    if (!isManagedChildPath(filePath, state.managedChildRoots)) continue;
    await dataStore.deleteFile(existing.id);
    existingByPath.delete(filePath);
    state.lastMutationAt = Date.now();
  }

  const allowEarlyExit = (state.existingByPath?.size ?? 0) > 0;
  let processed = 0;
  for await (const filePath of iterateLocalMediaPaths(folder.path, { yieldEvery: 200 })) {
    await processLocalFile(folder.id, filePath, state);
    if (state.pendingDeletes.size > 0) {
      await drainPendingDeletes(folder.id, state);
    }
    if (state.pendingPaths.size > 0) {
      await drainPendingPaths(folder.id, state);
    }
    if (allowEarlyExit && Date.now() - state.lastMutationAt > scanIdleTimeoutMs) {
      console.log(`[auto-scan] idle timeout during full scan for ${folder.path}`);
      break;
    }
    processed += 1;
    if (state.scanId && processed % 50 === 0) {
      await dataStore.updateScan(state.scanId, { progress: 0 });
    }
  }
};

const startScanSession = async (folderId: string, reason: string) => {
  const state = getScanState(folderId);
  if (state.running) return;
  state.running = true;
  state.providerRunsStarted = 0;

  let scanId: string | undefined;
  let folder: FolderRecord | null = null;

  try {
    folder = await dataStore.findFolderById(folderId);
    if (!folder) return;

    await fs.promises.access(folder.path, fs.constants.R_OK);
    await fs.promises.mkdir(config.storage.thumbnailsDir, { recursive: true });

    const existingFiles = await dataStore.listFiles(folderId);
    state.existingByPath = new Map(existingFiles.map((file) => [file.path, file]));
  state.managedChildRoots = await listManagedChildRoots(folder);

    const scan = await dataStore.createScan(folderId);
    scanId = scan.id;
    state.scanId = scanId;
    state.lastMutationAt = Date.now();
    await dataStore.updateScan(scanId, { status: 'RUNNING', progress: 0 });
    await dataStore.updateFolder(folderId, { status: 'SCANNING', lastScanAt: new Date().toISOString() });
    console.log(`[auto-scan] started scan ${scanId} for folder ${folder.path} (${reason})`);

    while (true) {
      if (state.needsFullScan) {
        state.needsFullScan = false;
        await runFullLocalScan(folder, state);
      }
      await drainPendingDeletes(folderId, state);
      await drainPendingPaths(folderId, state);

      if (state.needsFullScan || state.pendingDeletes.size > 0 || state.pendingPaths.size > 0) {
        continue;
      }

      const waitResult = await waitForPendingOrTimeout(state);
      if (waitResult === 'timeout') {
        if (state.needsFullScan || state.pendingDeletes.size > 0 || state.pendingPaths.size > 0) {
          continue;
        }
        break;
      }
    }

    if (scanId) {
      await dataStore.updateScan(scanId, { status: 'COMPLETED', progress: 1 });
    }
  } catch (err) {
    if (scanId) {
      await dataStore.updateScan(scanId, { status: 'FAILED', error: (err as Error).message });
    }
  } finally {
    if (folder) {
      await dataStore.updateFolder(folderId, { status: 'IDLE', lastScanAt: new Date().toISOString() });
    }
    state.running = false;
    state.scanId = undefined;
    state.wake = undefined;
    state.existingByPath = undefined;
    state.managedChildRoots = [];
    state.providerRunsStarted = 0;
    state.retryCounts.clear();

    if (state.needsFullScan || state.pendingDeletes.size > 0 || state.pendingPaths.size > 0) {
      void startScanSession(folderId, 'queued-while-closing');
    }
  }
};

const startFolderWatch = (folderId: string, folderPath: string) => {
  if (watchers.has(folderId)) return false;
  if (!fs.existsSync(folderPath)) {
    console.warn(`[auto-scan] watch skipped, path not found: ${folderPath}`);
    return false;
  }
  const watcher = chokidar.watch(folderPath, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 200
    },
    usePolling: false
  });
  watcher.on('add', (filePath) => {
    if (shouldIgnoreWatchedPath(folderId, filePath)) return;
    queuePathScan(folderId, filePath, 'file-added');
  });
  watcher.on('change', (filePath) => {
    if (shouldIgnoreWatchedPath(folderId, filePath)) return;
    queuePathScan(folderId, filePath, 'file-changed');
  });
  watcher.on('unlink', (filePath) => {
    if (shouldIgnoreWatchedPath(folderId, filePath)) return;
    queueDelete(folderId, filePath, 'file-removed');
  });
  watcher.on('error', (err) => {
    console.error(`[auto-scan] watcher error for ${folderPath}: ${err}`);
    watchers.delete(folderId);
    folderMtimeCache.delete(folderId);
    void watcher.close().catch(() => undefined);
  });
  watchers.set(folderId, watcher);
  console.log(`[auto-scan] watching ${folderPath}`);
  return true;
};

const refreshFolderWatchers = async (reason: string) => {
  const folders = await dataStore.listFolders();
  const activeIds = new Set(folders.map((folder) => folder.id));
  for (const [folderId, watcher] of watchers.entries()) {
    if (!activeIds.has(folderId)) {
      await watcher.close();
      watchers.delete(folderId);
      folderMtimeCache.delete(folderId);
      const state = scanStates.get(folderId);
      if (state && !state.running) {
        scanStates.delete(folderId);
      }
    }
  }
  const now = Date.now();
  for (const folder of folders) {
    if (folder.type === 'LOCAL') {
      const lastScanMs = folder.lastScanAt ? new Date(folder.lastScanAt).getTime() : 0;
      if (watchers.has(folder.id)) {
        if (localRescanIntervalMs > 0 && (!folder.lastScanAt || now - lastScanMs >= localRescanIntervalMs)) {
          queueFullScan(folder.id, 'periodic');
        }
        continue;
      }
      const started = startFolderWatch(folder.id, folder.path);
      if (started) {
        queueFullScan(folder.id, reason);
      }
      continue;
    }

    const lastScanMs = folder.lastScanAt ? new Date(folder.lastScanAt).getTime() : 0;
    if (!folder.lastScanAt || now - lastScanMs >= folderRefreshIntervalMs) {
      queueFullScan(folder.id, reason);
    }
  }
};

const pollLocalFolderChanges = async () => {
  const folders = await dataStore.listFolders();
  for (const folder of folders) {
    if (folder.type !== 'LOCAL') continue;
    try {
      const stats = await fs.promises.stat(folder.path);
      const previous = folderMtimeCache.get(folder.id);
      folderMtimeCache.set(folder.id, stats.mtimeMs);
      if (previous !== undefined && stats.mtimeMs > previous) {
        queueFullScan(folder.id, 'mtime-poll');
      }
    } catch (err) {
      console.warn(`[auto-scan] mtime poll failed for ${folder.path}: ${(err as Error).message}`);
    }
  }
};

const runProviderRefresh = async () => {
  if (providerRefreshRunning) return;
  providerRefreshRunning = true;
  try {
    const nowMs = Date.now();
    const due: { fileId: string; provider: ProviderKind }[] = [];
    const targetKeysByUser = new Map<string, Set<string>>();
    let cursor: { createdAt: string; id: string } | null = null;

    while (due.length < providerRefreshBatchSize) {
      const batch = await dataStore.listFilesBatch({
        limit: providerRefreshScanBatchSize,
        after: cursor
      });
      if (batch.files.length === 0) break;
      const providerRunsByFile = await dataStore.listProviderRunsByFileIds(batch.files.map((file) => file.id));

      for (const file of batch.files) {
        const owner = await dataStore.findUserByFileId(file.id);
        const userId = owner?.id ?? '';
        let targetKeys = targetKeysByUser.get(userId);
        if (!targetKeys) {
          const sauceSettings = userId ? await dataStore.getSauceSettings(userId) : { targets: [] as string[] };
          targetKeys = new Set((sauceSettings.targets ?? []).map(normalizeSauceKey));
          targetKeysByUser.set(userId, targetKeys);
        }
        const runs = providerRunsByFile[file.id];
        for (const provider of providerKinds) {
          if (isProviderDue(runs, provider, nowMs, targetKeys)) {
            due.push({ fileId: file.id, provider });
          }
          if (due.length >= providerRefreshBatchSize) break;
        }
        if (due.length >= providerRefreshBatchSize) break;
      }

      if (!batch.nextCursor) break;
      cursor = batch.nextCursor;
    }

    if (!due.length) return;
    shuffle(due);

    const batch = due.slice(0, providerRefreshBatchSize);
    for (const item of batch) {
      const file = await dataStore.findFileById(item.fileId);
      if (!file) continue;
      await executeProviderRun(file, item.provider);
    }
  } finally {
    providerRefreshRunning = false;
  }
};

const pickMissingProviderRun = async () => {
  if (missingProviderRunning || providerRefreshRunning) return;
  missingProviderRunning = true;
  try {
    const candidates: { file: FileRecord; provider: ProviderKind }[] = [];
    const targetKeysByUser = new Map<string, Set<string>>();

    for (const provider of providerKinds) {
      const files = dataStore.listFilesWithoutProviderRun(provider, missingProviderCandidateLimit);
      for (const file of files) {
        const owner = await dataStore.findUserByFileId(file.id);
        const userId = owner?.id ?? '';
        let targetKeys = targetKeysByUser.get(userId);
        if (!targetKeys) {
          const sauceSettings = userId ? await dataStore.getSauceSettings(userId) : { targets: [] as string[] };
          targetKeys = new Set((sauceSettings.targets ?? []).map(normalizeSauceKey));
          targetKeysByUser.set(userId, targetKeys);
        }
        const runs = await dataStore.listProviderRuns(file.id);
        if (targetKeys.size > 0 && hasTargetSauce(runs, targetKeys)) continue;
        candidates.push({ file, provider });
      }
    }

    if (!candidates.length) return;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    await executeProviderRun(pick.file, pick.provider);
  } finally {
    missingProviderRunning = false;
  }
};

const scheduleMissingProviderScan = () => {
  if (missingProviderTimer) clearTimeout(missingProviderTimer);
  const delay =
    missingProviderMinMs + Math.floor(Math.random() * (missingProviderMaxMs - missingProviderMinMs + 1));
  missingProviderTimer = setTimeout(async () => {
    await pickMissingProviderRun();
    scheduleMissingProviderScan();
  }, delay);
};

const scheduleFavoritesSync = () => {
  if (favoritesSyncTimer) clearTimeout(favoritesSyncTimer);
  if (favoritesSyncInterval) clearInterval(favoritesSyncInterval);
  if (!favoritesSyncIntervalMs || favoritesSyncIntervalMs <= 0) return;
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  const delay = Math.max(0, nextMidnight.getTime() - now.getTime());
  const maybeStartFavoritesSync = async () => {
    const users = await dataStore.listUsers();
    for (const user of users) {
      const settings = await dataStore.getFavoritesSettings(user.id);
      if (!settings.autoSyncMidnight) continue;
      startFavoritesSync(user.id);
    }
  };
  favoritesSyncTimer = setTimeout(() => {
    void maybeStartFavoritesSync();
    favoritesSyncInterval = setInterval(() => {
      void maybeStartFavoritesSync();
    }, favoritesSyncIntervalMs);
  }, delay);
};

const isTaggerAvailable = async (): Promise<boolean> => {
  if (!config.tagger.url) return false;
  try {
    const res = await fetch(`${config.tagger.url}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
};

const runWd14Backfill = async () => {
  if (wd14BackfillRunning) return;
  if (!(await isTaggerAvailable())) return;
  wd14BackfillRunning = true;
  try {
    let cursor: { createdAt: string; id: string } | null = null;
    while (true) {
      const batch = await dataStore.listFilesBatch({
        limit: wd14BackfillBatchSize,
        after: cursor,
        mediaType: 'IMAGE'
      });
      if (batch.files.length === 0) break;
      for (const file of batch.files) {
        await ensureWd14Tags(file, false, { ignoreSourceTags: true });
      }
      if (!batch.nextCursor) break;
      cursor = batch.nextCursor;
    }
  } finally {
    wd14BackfillRunning = false;
  }
};

const scheduleWd14Backfill = () => {
  if (wd14BackfillTimer) clearInterval(wd14BackfillTimer);
  if (!wd14BackfillIntervalMs || wd14BackfillIntervalMs <= 0) return;
  wd14BackfillTimer = setInterval(() => {
    void runWd14Backfill();
  }, wd14BackfillIntervalMs);
};

export const startAutoScanner = async () => {
  await dataStore.clearPendingAndRunning();
  const userCount = await dataStore.countUsers();

  if (localRescanIntervalMs > 0) {
    console.log(`[worker] local periodic rescan enabled (${Math.round(localRescanIntervalMs / 60000)} min)`);
  } else {
    console.log('[worker] local periodic rescan disabled; relying on watcher events and mtime polling');
  }

  if (userCount === 0 && config.folderPaths.length > 0) {
    await dataStore.ensureFolders(config.folderPaths);
  } else if (userCount === 0 && config.mediaPath) {
    await fs.promises.mkdir(config.mediaPath, { recursive: true });
    const existing = await dataStore.listFolders();
    if (existing.length === 1 && existing[0]?.path === '/media' && config.mediaPath !== '/media') {
      await dataStore.updateFolder(existing[0].id, { path: config.mediaPath });
    } else if (existing.length === 0) {
      await dataStore.ensureFolders([config.mediaPath]);
    }
  }
  await refreshFolderWatchers('startup');
  void pollLocalFolderChanges();
  setInterval(() => {
    void refreshFolderWatchers('added');
  }, folderRefreshIntervalMs);
  setInterval(() => {
    void pollLocalFolderChanges();
  }, folderPollIntervalMs);
  void runProviderRefresh();
  setInterval(() => {
    void runProviderRefresh();
  }, providerRefreshIntervalMs);
  scheduleMissingProviderScan();
  scheduleFavoritesSync();
  scheduleWd14Backfill();
};

if (require.main === module) {
  console.log('[worker] auto-scan manager started');
  void startAutoScanner();
}
