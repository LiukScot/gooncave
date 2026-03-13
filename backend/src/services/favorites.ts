import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

import { fetch } from 'undici';

import { config } from '../config';
import { dataStore, FavoriteProvider, FavoriteItemRecord, FileRecord } from '../lib/dataStore';
import { scanLocalFile } from '../lib/scanner';
import { resolveCredential } from './credentials';
import { applyRemotePostTags } from './tagging';

type FavoriteRemote = {
  provider: FavoriteProvider;
  remoteId: string;
  sourceUrl: string;
  fileUrl: string | null;
};

type SyncResult = {
  provider: FavoriteProvider;
  fetched: number;
  added: number;
  removed: number;
  skipped: number;
  errors: string[];
};

type SyncOptions = {
  providers?: FavoriteProvider[];
  deleteMissing?: boolean;
};

type ProviderStage = 'idle' | 'fetching' | 'downloading' | 'deleting' | 'done' | 'error';

type FavoriteSyncProgress = {
  provider: FavoriteProvider;
  stage: ProviderStage;
  fetched: number;
  total: number;
  processed: number;
  added: number;
  removed: number;
  skipped: number;
  errors: string[];
};

type FavoriteSyncState = {
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
  startedAt: string | null;
  updatedAt: string;
  progress: { providers: FavoriteSyncProgress[] } | null;
  results: SyncResult[];
};

let syncRunning = false;
let syncState: FavoriteSyncState = {
  status: 'idle',
  message: 'Idle',
  startedAt: null,
  updatedAt: new Date().toISOString(),
  progress: null,
  results: []
};

const debugLog = (...args: string[]) => {
  if (!config.favorites.debug) return;
  console.log('[favorites]', ...args);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureFavoritesRoot = async () => {
  const settings = await dataStore.getFavoritesSettings();
  if (settings.favoritesRootId) {
    const folder = await dataStore.findFolderById(settings.favoritesRootId);
    if (folder?.type === 'LOCAL') {
      await fs.promises.mkdir(folder.path, { recursive: true });
      return folder.path;
    }
  }
  const baseFromConfig = config.favorites.root || config.folderPaths[0];
  if (baseFromConfig) {
    await fs.promises.mkdir(baseFromConfig, { recursive: true });
    return baseFromConfig;
  }
  const folders = await dataStore.listFolders();
  const localFolder = folders.find((folder) => folder.type === 'LOCAL');
  if (!localFolder?.path) {
    throw new Error('Favorites root not configured. Set FAVORITES_ROOT or FOLDER_PATHS, or add a local folder.');
  }
  await fs.promises.mkdir(localFolder.path, { recursive: true });
  return localFolder.path;
};

const ensureFavoritesFolder = async (root: string) => {
  const existing = await dataStore.findFolderByPath(root);
  if (existing) return existing;
  return dataStore.addFolder(root);
};

const scanAndUpsertFavorite = async (folderId: string, filePath: string): Promise<FileRecord | null> => {
  const scanned = await scanLocalFile(filePath, { thumbnailsDir: config.storage.thumbnailsDir });
  if (!scanned) return null;
  return dataStore.upsertFile(folderId, scanned);
};

const findOrScanFavoriteRecord = async (folderId: string, filePath: string): Promise<FileRecord | null> => {
  const existing = await dataStore.findFileByPath(filePath);
  if (existing) return existing;
  return scanAndUpsertFavorite(folderId, filePath);
};

const favoriteSourceName = (provider: FavoriteProvider) => (provider === 'E621' ? 'e621' : 'danbooru');

const providerThreshold = (provider: 'SAUCENAO' | 'FLUFFLE') => (provider === 'FLUFFLE' ? 95 : 90);

const hasHighConfidenceSource = (file: FileRecord, sourceUrl: string) => {
  return dataStore.listProviderRuns(file.id).then((runs) =>
    runs.some((run) => {
      const threshold = providerThreshold(run.provider);
      const results = Array.isArray(run.results) && run.results.length
        ? run.results
        : run.sourceUrl
          ? [{ sourceUrl: run.sourceUrl, score: run.score, sourceName: null, thumbUrl: run.thumbUrl }]
          : [];
      return results.some(
        (result) =>
          result.sourceUrl === sourceUrl &&
          typeof result.score === 'number' &&
          Number.isFinite(result.score) &&
          result.score >= threshold
      );
    })
  );
};

const ensureFavoriteSourceRun = async (file: FileRecord, item: FavoriteRemote) => {
  if (!(await hasHighConfidenceSource(file, item.sourceUrl))) {
    const run = await dataStore.createProviderRun(file.id, 'SAUCENAO');
    await dataStore.updateProviderRun(run.id, {
      status: 'COMPLETED',
      cachedHit: true,
      score: 100,
      sourceUrl: item.sourceUrl,
      thumbUrl: null,
      results: [
        {
          sourceUrl: item.sourceUrl,
          score: 100,
          sourceName: favoriteSourceName(item.provider),
          thumbUrl: null
        }
      ],
      completedAt: new Date().toISOString(),
      error: null
    });
  }
};

const hasProviderSourceTags = async (fileId: string, provider: FavoriteProvider) => {
  const tags = await dataStore.listTagsForFile(fileId);
  return tags.some((tag) => tag.source === provider);
};

const ensureFavoriteSourceMetadata = async (file: FileRecord, item: FavoriteRemote) => {
  await ensureFavoriteSourceRun(file, item);
  if (await hasProviderSourceTags(file.id, item.provider)) return;
  await applyRemotePostTags(file, item.provider, item.remoteId, item.sourceUrl);
};

const resolveE621Auth = async () => {
  const credential = await resolveCredential('E621');
  if (!credential.username || !credential.apiKey) return null;
  return { username: credential.username, apiKey: credential.apiKey, userAgent: config.e621.userAgent };
};

const resolveDanbooruAuth = async () => {
  const credential = await resolveCredential('DANBOORU');
  if (!credential.username || !credential.apiKey) return null;
  return { username: credential.username, apiKey: credential.apiKey, userAgent: config.e621.userAgent };
};

const toSafeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '');

const pickExtension = (fileUrl: string) => {
  try {
    const url = new URL(fileUrl);
    const ext = path.extname(url.pathname);
    if (ext && ext.length <= 8) return ext.toLowerCase();
  } catch {
    // ignore
  }
  return '.jpg';
};

const buildFavoritePath = (root: string, provider: FavoriteProvider, remoteId: string, fileUrl: string) => {
  const ext = pickExtension(fileUrl);
  const safeId = toSafeId(remoteId) || remoteId;
  const fileName = `${provider.toLowerCase()}-${safeId}${ext}`;
  return path.join(root, fileName);
};

const downloadFile = async (url: string, destPath: string, headers: Record<string, string>) => {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.part`;
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`Download failed (${res.status}): ${text.slice(0, 200)}`);
  }
  await pipeline(res.body as any, fs.createWriteStream(tempPath));
  await fs.promises.rename(tempPath, destPath);
};

const deleteFavoriteFile = async (item: FavoriteItemRecord) => {
  try {
    await fs.promises.unlink(item.filePath);
  } catch {
    // ignore missing files
  }
  const record = await dataStore.findFileByPath(item.filePath);
  if (record?.thumbPath) {
    try {
      await fs.promises.unlink(record.thumbPath);
    } catch {
      // ignore
    }
  }
  if (record) {
    await dataStore.deleteFile(record.id);
  }
  await dataStore.deleteFavoriteItem(item.provider, item.remoteId);
};

const unfavoriteE621 = async (postId: string) => {
  const auth = await resolveE621Auth();
  if (!auth) {
    throw new Error('E621 credentials missing');
  }
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const res = await fetch(`https://e621.net/favorites/${postId}.json`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${token}`,
      'User-Agent': auth.userAgent
    }
  });
  if (res.ok || res.status === 404) return;
  const text = await res.text();
  throw new Error(`e621 unfavorite failed (${res.status}): ${text.slice(0, 200)}`);
};

const unfavoriteDanbooru = async (postId: string) => {
  const auth = await resolveDanbooruAuth();
  if (!auth) {
    throw new Error('Danbooru credentials missing');
  }
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const res = await fetch(`https://danbooru.donmai.us/favorites/${postId}.json`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${token}`,
      'User-Agent': auth.userAgent
    }
  });
  if (res.ok || res.status === 404) return;
  const text = await res.text();
  throw new Error(`danbooru unfavorite failed (${res.status}): ${text.slice(0, 200)}`);
};

export const removeFavorite = async (provider: FavoriteProvider, remoteId: string) => {
  if (provider === 'E621') {
    await unfavoriteE621(remoteId);
    return;
  }
  await unfavoriteDanbooru(remoteId);
};

const fetchE621Favorites = async (onPage?: (page: number, count: number) => void) => {
  const auth = await resolveE621Auth();
  if (!auth) {
    throw new Error('E621 credentials missing');
  }
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const headers = {
    Authorization: `Basic ${token}`,
    'User-Agent': auth.userAgent
  };
  const items: FavoriteRemote[] = [];
  const limit = 320;
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      tags: `fav:${auth.username}`,
      limit: String(limit),
      page: String(page)
    });
    const res = await fetch(`https://e621.net/posts.json?${params.toString()}`, { headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`e621 favorites failed (${res.status}): ${text.slice(0, 200)}`);
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`e621 favorites parse failed: ${text.slice(0, 200)}`);
    }
    const posts: any[] = Array.isArray(data?.posts) ? data.posts : [];
    if (!posts.length) break;
    onPage?.(page, posts.length);
    for (const post of posts) {
      const id = post?.id ? String(post.id) : null;
      const fileUrl = post?.file?.url ?? null;
      if (!id) continue;
      items.push({
        provider: 'E621',
        remoteId: id,
        sourceUrl: `https://e621.net/posts/${id}`,
        fileUrl
      });
    }
    if (posts.length < limit) break;
    page += 1;
    await sleep(200);
  }
  return { items, headers };
};

const fetchDanbooruFavorites = async (onPage?: (page: number, count: number) => void) => {
  const auth = await resolveDanbooruAuth();
  if (!auth) {
    throw new Error('Danbooru credentials missing');
  }
  const token = Buffer.from(`${auth.username}:${auth.apiKey}`).toString('base64');
  const headers = {
    Authorization: `Basic ${token}`,
    'User-Agent': auth.userAgent
  };
  const items: FavoriteRemote[] = [];
  const limit = 200;
  let page = 1;
  while (true) {
    const params = new URLSearchParams({
      tags: `fav:${auth.username}`,
      limit: String(limit),
      page: String(page)
    });
    const res = await fetch(`https://danbooru.donmai.us/posts.json?${params.toString()}`, { headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`danbooru favorites failed (${res.status}): ${text.slice(0, 200)}`);
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`danbooru favorites parse failed: ${text.slice(0, 200)}`);
    }
    const posts: any[] = Array.isArray(data) ? data : Array.isArray(data?.posts) ? data.posts : [];
    if (!posts.length) break;
    onPage?.(page, posts.length);
    for (const post of posts) {
      const id = post?.id ? String(post.id) : null;
      const fileUrl = post?.file_url ?? post?.large_file_url ?? null;
      if (!id) continue;
      items.push({
        provider: 'DANBOORU',
        remoteId: id,
        sourceUrl: `https://danbooru.donmai.us/posts/${id}`,
        fileUrl
      });
    }
    if (posts.length < limit) break;
    page += 1;
    await sleep(200);
  }
  return { items, headers };
};

const initProviderProgress = (provider: FavoriteProvider): FavoriteSyncProgress => ({
  provider,
  stage: 'idle',
  fetched: 0,
  total: 0,
  processed: 0,
  added: 0,
  removed: 0,
  skipped: 0,
  errors: []
});

const syncProvider = async (
  provider: FavoriteProvider,
  deleteMissing: boolean,
  root: string,
  onProgress: (provider: FavoriteProvider, patch: Partial<FavoriteSyncProgress>, message?: string) => void
): Promise<SyncResult> => {
  const result: SyncResult = { provider, fetched: 0, added: 0, removed: 0, skipped: 0, errors: [] };
  let remote: FavoriteRemote[] = [];
  let headers: Record<string, string> = {};
  debugLog(`${provider}: start`);
  if (provider === 'E621') {
    onProgress(provider, { stage: 'fetching' }, 'Fetching e621 favorites…');
    const fetched = await fetchE621Favorites((page, count) => {
      const message = `Fetching e621 favorites (page ${page}, ${count} items)…`;
      onProgress(provider, { stage: 'fetching' }, message);
      debugLog(message);
    });
    remote = fetched.items;
    headers = fetched.headers;
  } else {
    onProgress(provider, { stage: 'fetching' }, 'Fetching danbooru favorites…');
    const fetched = await fetchDanbooruFavorites((page, count) => {
      const message = `Fetching danbooru favorites (page ${page}, ${count} items)…`;
      onProgress(provider, { stage: 'fetching' }, message);
      debugLog(message);
    });
    remote = fetched.items;
    headers = fetched.headers;
  }

  result.fetched = remote.length;
  onProgress(
    provider,
    { fetched: remote.length, total: remote.length, processed: 0, stage: 'downloading' },
    `Downloading ${provider.toLowerCase()} favorites…`
  );

  const folder = await ensureFavoritesFolder(root);
  const existingItems = await dataStore.listFavoriteItems(provider);
  const existingById = new Map(existingItems.map((item) => [item.remoteId, item]));
  const remoteIds = new Set(remote.map((item) => item.remoteId));

  let processed = 0;
  for (const item of remote) {
    const existing = existingById.get(item.remoteId);
    const filePath =
      existing?.filePath ?? (item.fileUrl ? buildFavoritePath(root, provider, item.remoteId, item.fileUrl) : '');
    const fileExists = filePath ? fs.existsSync(filePath) : false;
    if (existing && fileExists) {
      await dataStore.upsertFavoriteItem({
        provider,
        remoteId: item.remoteId,
        filePath,
        sourceUrl: item.sourceUrl,
        fileUrl: item.fileUrl
      });
      try {
        const record = await findOrScanFavoriteRecord(folder.id, filePath);
        if (record) {
          await ensureFavoriteSourceMetadata(record, item);
        }
      } catch (err) {
        const message = `${provider} ${item.remoteId}: source/tag import failed (${(err as Error).message})`;
        result.errors.push(message);
        onProgress(provider, { errors: result.errors });
        debugLog(message);
      }
      result.skipped += 1;
      processed += 1;
      if (processed % 10 === 0) {
        onProgress(provider, { processed, skipped: result.skipped });
      }
      continue;
    }
    if (!item.fileUrl) {
      if (existing) {
        await dataStore.upsertFavoriteItem({
          provider,
          remoteId: item.remoteId,
          filePath: existing.filePath,
          sourceUrl: item.sourceUrl,
          fileUrl: null
        });
        try {
          const record = await findOrScanFavoriteRecord(folder.id, existing.filePath);
          if (record) {
            await ensureFavoriteSourceMetadata(record, item);
          }
        } catch (err) {
          const message = `${provider} ${item.remoteId}: source/tag import failed (${(err as Error).message})`;
          result.errors.push(message);
          onProgress(provider, { errors: result.errors });
          debugLog(message);
        }
      }
      result.skipped += 1;
      processed += 1;
      if (processed % 10 === 0) {
        onProgress(provider, { processed, skipped: result.skipped });
      }
      continue;
    }
    try {
      await downloadFile(item.fileUrl, filePath, headers);
      await dataStore.upsertFavoriteItem({
        provider,
        remoteId: item.remoteId,
        filePath,
        sourceUrl: item.sourceUrl,
        fileUrl: item.fileUrl
      });
      result.added += 1;
      try {
        const record = await findOrScanFavoriteRecord(folder.id, filePath);
        if (record) {
          await ensureFavoriteSourceMetadata(record, item);
        }
      } catch (err) {
        const message = `${provider} ${item.remoteId}: source/tag import failed (${(err as Error).message})`;
        result.errors.push(message);
        onProgress(provider, { errors: result.errors });
        debugLog(message);
      }
    } catch (err) {
      const message = `${provider} ${item.remoteId}: ${(err as Error).message}`;
      result.errors.push(message);
      onProgress(provider, { errors: result.errors });
      debugLog(message);
    }
    processed += 1;
    if (processed % 10 === 0 || processed === remote.length) {
      onProgress(provider, { processed, added: result.added, skipped: result.skipped });
    }
  }
  if (processed % 10 !== 0) {
    onProgress(provider, { processed, added: result.added, skipped: result.skipped });
  }

  if (deleteMissing) {
    const missing = existingItems.filter((item) => !remoteIds.has(item.remoteId));
    let removedProcessed = 0;
    onProgress(
      provider,
      { stage: 'deleting', total: missing.length, processed: 0, removed: result.removed },
      `Removing unfavorited ${provider.toLowerCase()} items…`
    );
    debugLog(`${provider}: removing ${missing.length} unfavorited items`);
    for (const existing of existingItems) {
      if (remoteIds.has(existing.remoteId)) continue;
      await deleteFavoriteFile(existing);
      result.removed += 1;
      removedProcessed += 1;
      if (removedProcessed % 10 === 0 || removedProcessed === missing.length) {
        onProgress(provider, { processed: removedProcessed, removed: result.removed });
      }
    }
  }

  onProgress(
    provider,
    { stage: 'done', processed: result.fetched, added: result.added, removed: result.removed },
    `${provider.toLowerCase()} favorites synced.`
  );
  debugLog(`${provider}: done (added ${result.added}, removed ${result.removed}, skipped ${result.skipped})`);
  return result;
};

const updateSyncState = (patch: Partial<FavoriteSyncState>) => {
  syncState = {
    ...syncState,
    ...patch,
    updatedAt: new Date().toISOString()
  };
};

const createProgressUpdater = (providers: FavoriteProvider[]) => {
  const progressMap = new Map<FavoriteProvider, FavoriteSyncProgress>(
    providers.map((provider) => [provider, initProviderProgress(provider)])
  );
  return {
    update(provider: FavoriteProvider, patch: Partial<FavoriteSyncProgress>, message?: string) {
      const existing = progressMap.get(provider) ?? initProviderProgress(provider);
      const next = { ...existing, ...patch };
      progressMap.set(provider, next);
      updateSyncState({
        message: message ?? syncState.message,
        progress: { providers: Array.from(progressMap.values()) }
      });
      if (message) debugLog(message);
    },
    snapshot() {
      return { providers: Array.from(progressMap.values()) };
    }
  };
};

const runFavoritesSync = async (options: SyncOptions) => {
  try {
    const root = await ensureFavoritesRoot();
    const providers = options.providers?.length ? options.providers : (['E621', 'DANBOORU'] as FavoriteProvider[]);
    const deleteMissing = options.deleteMissing ?? config.favorites.deleteMissing;
    const results: SyncResult[] = [];
    const progress = createProgressUpdater(providers);
    updateSyncState({
      status: 'running',
      message: 'Starting favorites sync…',
      progress: progress.snapshot(),
      results: []
    });
    debugLog('sync started');
    for (const provider of providers) {
      try {
        results.push(await syncProvider(provider, deleteMissing, root, progress.update));
      } catch (err) {
        results.push({
          provider,
          fetched: 0,
          added: 0,
          removed: 0,
          skipped: 0,
          errors: [(err as Error).message]
        });
        progress.update(provider, { stage: 'error', errors: [(err as Error).message] });
        debugLog(`${provider}: error ${(err as Error).message}`);
      }
    }
    updateSyncState({
      status: 'done',
      message: 'Favorites sync complete.',
      results,
      progress: progress.snapshot()
    });
    debugLog('sync complete');
  } catch (err) {
    updateSyncState({
      status: 'error',
      message: `Favorites sync failed: ${(err as Error).message}`
    });
    debugLog(`sync failed: ${(err as Error).message}`);
  } finally {
    syncRunning = false;
  }
};

export const getFavoritesSyncStatus = () => syncState;

export const startFavoritesSync = (options: SyncOptions = {}) => {
  if (syncRunning) {
    return { status: 'busy', state: syncState };
  }
  const now = new Date().toISOString();
  updateSyncState({
    status: 'running',
    message: 'Starting favorites sync…',
    startedAt: now,
    results: [],
    progress: null
  });
  syncRunning = true;
  void runFavoritesSync(options);
  return { status: 'started', state: syncState };
};
