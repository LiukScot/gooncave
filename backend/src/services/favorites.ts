import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { fetch } from 'undici';

import { config } from '../config';
import { getEngine } from '../lib/booruEngines';
import {
  BooruSiteRecord,
  dataStore,
  FavoriteProvider,
  FavoriteItemRecord,
  FileRecord
} from '../lib/dataStore';
import { extractFavoriteRemoteFromSiteList } from '../lib/favoriteSourceMatch';
import { ensureDirectoryWritable } from '../lib/fsAccess';
import { scanLocalFile } from '../lib/scanner';

import { applyRemotePostTags } from './tagging';

// favorite_items.provider for a given site is the preset key when the site is
// one of the seeded presets (so legacy 'E621'/'DANBOORU' rows continue to
// match) and the site UUID for fully-custom sites.
const favoriteKeyForSite = (site: BooruSiteRecord): string => site.presetKey ?? site.id;

const resolveSiteFromProvider = async (
  userId: string,
  provider: FavoriteProvider
): Promise<BooruSiteRecord | null> => {
  // direct id lookup
  const byId = await dataStore.getBooruSite(provider, userId);
  if (byId) return byId;
  // legacy preset key lookup ('E621', 'DANBOORU', ...)
  return dataStore.findBooruSiteByPresetKey(provider, userId);
};

const loadFavoriteSyncableSites = async (userId: string): Promise<BooruSiteRecord[]> => {
  const sites = await dataStore.listBooruSites(userId);
  return sites.filter(
    (site) => site.enabled && site.capFavorites && site.username && site.apiKey
  );
};

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

const syncRunningByUser = new Map<string, boolean>();
const syncStateByUser = new Map<string, FavoriteSyncState>();

const defaultSyncState = (): FavoriteSyncState => ({
  status: 'idle',
  message: 'Idle',
  startedAt: null,
  updatedAt: new Date().toISOString(),
  progress: null,
  results: []
});

const getSyncState = (userId: string) => {
  const existing = syncStateByUser.get(userId);
  if (existing) return existing;
  const created = defaultSyncState();
  syncStateByUser.set(userId, created);
  return created;
};

const debugLog = (...args: string[]) => {
  if (!config.favorites.debug) return;
  console.log('[favorites]', ...args);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ensureFavoritesRoot = async (userId: string) => {
  const settings = await dataStore.getFavoritesSettings(userId);
  if (settings.favoritesRootId) {
    const folder = await dataStore.findFolderById(settings.favoritesRootId, userId);
    if (folder?.type === 'LOCAL') {
      await ensureDirectoryWritable(folder.path, 'Favorites sync');
      return folder.path;
    }
  }
  const user = await dataStore.findUserById(userId);
  if (user?.libraryRoot) {
    await ensureDirectoryWritable(user.libraryRoot, 'Favorites sync');
    return user.libraryRoot;
  }
  const folders = await dataStore.listFolders(userId);
  const localFolder = folders.find((folder) => folder.type === 'LOCAL');
  if (!localFolder?.path) {
    throw new Error('Favorites root not configured. Add a local folder for this account.');
  }
  await ensureDirectoryWritable(localFolder.path, 'Favorites sync');
  return localFolder.path;
};

export const assertFavoritesSyncReady = async (userId: string) => {
  await ensureFavoritesRoot(userId);
};

const ensureFavoritesFolder = async (root: string, userId: string) => {
  const existing = await dataStore.findFolderByPath(root, userId);
  if (existing) return existing;
  return dataStore.addFolder(root, userId);
};

const scanAndUpsertFavorite = async (folderId: string, filePath: string): Promise<FileRecord | null> => {
  const scanned = await scanLocalFile(filePath, { thumbnailsDir: config.storage.thumbnailsDir });
  if (!scanned) return null;
  return dataStore.upsertFile(folderId, scanned);
};

const findOrScanFavoriteRecord = async (folderId: string, filePath: string, userId: string): Promise<FileRecord | null> => {
  const existing = await dataStore.findFileByPath(filePath, userId);
  if (existing) return existing;
  return scanAndUpsertFavorite(folderId, filePath);
};

const favoriteSourceName = (provider: FavoriteProvider): string => {
  if (provider === 'E621') return 'e621';
  if (provider === 'DANBOORU') return 'danbooru';
  return provider;
};

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

const isPathInsideRoot = (candidatePath: string, root: string) => {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidatePath);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

const resolveFavoriteFilePath = (root: string, item: FavoriteRemote, existingPath?: string | null) => {
  const normalizedExisting = existingPath ? path.resolve(existingPath) : '';
  if (!item.fileUrl) {
    if (!normalizedExisting) return '';
    if (isPathInsideRoot(normalizedExisting, root)) return normalizedExisting;
    const candidate = path.join(root, path.basename(normalizedExisting));
    return fs.existsSync(candidate) ? candidate : normalizedExisting;
  }

  const preferred = buildFavoritePath(root, item.provider, item.remoteId, item.fileUrl);
  if (!normalizedExisting) return preferred;
  if (normalizedExisting === path.resolve(preferred)) return preferred;
  if (path.basename(normalizedExisting) === path.basename(preferred)) return preferred;
  if (isPathInsideRoot(normalizedExisting, root)) return normalizedExisting;
  // Auto-fav marker: existing row points to a real local file outside the favorites
  // root (e.g. a file the user uploaded that the sauce scanner matched on e621).
  // Honor it so sync does not duplicate-download into the favorites root.
  if (fs.existsSync(normalizedExisting)) return normalizedExisting;
  return preferred;
};

const downloadFile = async (url: string, destPath: string, headers: Record<string, string>) => {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.part`;
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`Download failed (${res.status}): ${text.slice(0, 200)}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tempPath));
    await fs.promises.rename(tempPath, destPath);
  } catch (err) {
    await fs.promises.unlink(tempPath).catch(() => undefined);
    throw err;
  }
};

const deleteFavoriteFile = async (userId: string, item: FavoriteItemRecord) => {
  try {
    await fs.promises.unlink(item.filePath);
  } catch {
    // ignore missing files
  }
  const record = await dataStore.findFileByPath(item.filePath, userId);
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
  await dataStore.deleteFavoriteItem(item.provider, item.remoteId, userId);
};

// Engine-dispatched favorite / unfavorite. Resolves the site row by site id or
// legacy preset key, then calls the engine module's network adapter.
export const removeFavorite = async (
  userId: string,
  provider: FavoriteProvider,
  remoteId: string
) => {
  const site = await resolveSiteFromProvider(userId, provider);
  if (!site) throw new Error(`Unknown booru provider: ${provider}`);
  const engine = getEngine(site.engine);
  if (!engine?.unfavorite) {
    throw new Error(`Engine ${site.engine} does not support unfavorite`);
  }
  await engine.unfavorite(site, remoteId);
};

const favoriteOnSite = async (site: BooruSiteRecord, postId: string) => {
  const engine = getEngine(site.engine);
  if (!engine?.favorite) {
    throw new Error(`Engine ${site.engine} does not support favorite`);
  }
  await engine.favorite(site, postId);
};

export type AutoFavoriteOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'favorited'; provider: FavoriteProvider; remoteId: string }
  | { status: 'error'; reason: string };

const resolveFileUserIdSafe = async (file: FileRecord): Promise<string | null> => {
  try {
    const owner = await dataStore.findUserByFileId(file.id);
    return owner?.id ?? null;
  } catch (err) {
    console.error('[auto-fav] failed to resolve owner for file', file.id, err);
    return null;
  }
};

type ScoredFavoritableMatch = {
  provider: FavoriteProvider;
  remoteId: string;
  sourceUrl: string;
};

// Walk every provider run's results (not just the top match) and pick the
// best supported-provider hit above the per-provider threshold. The top
// result is often an unsupported site (e.g. furaffinity) even when a lower
// ranked result points at a provider we can auto-favorite on; we still want
// to favorite that one. Candidate sites come from the caller's
// user_booru_sites list, so adding a site automatically extends this lookup.
const findBestFavoritableMatch = async (
  fileId: string,
  sites: BooruSiteRecord[]
): Promise<ScoredFavoritableMatch | null> => {
  const runs = await dataStore.listProviderRuns(fileId);
  let best: { match: ScoredFavoritableMatch; score: number } | null = null;
  for (const run of runs) {
    if (run.status !== 'COMPLETED') continue;
    const threshold = providerThreshold(run.provider);
    const candidates = run.results?.length
      ? run.results
      : run.sourceUrl
        ? [{ sourceUrl: run.sourceUrl, score: run.score, sourceName: null, thumbUrl: null }]
        : [];
    for (const candidate of candidates) {
      const score = candidate.score;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < threshold) continue;
      const remote = extractFavoriteRemoteFromSiteList(candidate.sourceUrl, sites);
      if (!remote) continue;
      if (!best || score > best.score) {
        best = {
          match: {
            provider: favoriteKeyForSite(remote.site),
            remoteId: remote.remoteId,
            sourceUrl: candidate.sourceUrl ?? ''
          },
          score
        };
      }
    }
  }
  return best?.match ?? null;
};

// Auto-favorite a local file on its source site when the sauce scanner found
// a high-confidence match on a supported provider (e621/danbooru). Writes a
// favorite_items row pointing at the local file path so the next sync
// recognises it (option C of #66) and skips re-downloading the post into the
// favorites root. Opt-in via settings.
export const autoFavoriteFromSauce = async (file: FileRecord): Promise<AutoFavoriteOutcome> => {
  const userId = await resolveFileUserIdSafe(file);
  if (!userId) return { status: 'skipped', reason: 'no-owner' };

  const settings = await dataStore.getFavoritesSettings(userId);
  if (!settings.autoFavEnabled) return { status: 'skipped', reason: 'disabled' };

  // Match URL against every site that opted into source-match (cap_source_match).
  // Don't pre-filter by favorites capability or credentials here: the
  // already-marked short-circuit below must fire even when the site is
  // disabled / missing creds, otherwise reverse-sync / repeated scans would
  // get the wrong outcome.
  const allSites = await dataStore.listBooruSites(userId);
  const matchSites = allSites.filter((site) => site.capSourceMatch);
  const remote = await findBestFavoritableMatch(file.id, matchSites);
  if (!remote) return { status: 'skipped', reason: 'no-supported-match' };

  const existing = await dataStore.findFavoriteItemByPath(file.path, userId);
  if (existing && existing.provider === remote.provider && existing.remoteId === remote.remoteId) {
    return { status: 'skipped', reason: 'already-marked' };
  }

  const targetSite = await resolveSiteFromProvider(userId, remote.provider);
  if (!targetSite) return { status: 'error', reason: `unknown provider: ${remote.provider}` };
  if (!targetSite.capFavorites) {
    return { status: 'skipped', reason: 'favorites-capability-disabled' };
  }
  if (!targetSite.username || !targetSite.apiKey) {
    return { status: 'skipped', reason: 'credentials-missing' };
  }

  try {
    await favoriteOnSite(targetSite, remote.remoteId);
  } catch (err) {
    return { status: 'error', reason: (err as Error).message };
  }

  await dataStore.upsertFavoriteItem(
    {
      provider: remote.provider,
      remoteId: remote.remoteId,
      filePath: file.path,
      sourceUrl: remote.sourceUrl || null,
      fileUrl: null
    },
    userId
  );

  return { status: 'favorited', provider: remote.provider, remoteId: remote.remoteId };
};

const fetchSiteFavorites = async (
  site: BooruSiteRecord,
  onPage?: (page: number, count: number) => void
): Promise<{ items: FavoriteRemote[]; headers: Record<string, string> }> => {
  const engine = getEngine(site.engine);
  if (!engine?.fetchFavorites) {
    throw new Error(`Engine ${site.engine} does not support favorites sync`);
  }
  const provider = favoriteKeyForSite(site);
  const result = await engine.fetchFavorites(site, { onPage });
  // Engine emits provider = site.id; remap to legacy preset key when present
  // so that existing favorite_items rows keep matching across the migration.
  const items: FavoriteRemote[] = result.items.map((item) => ({
    provider,
    remoteId: item.remoteId,
    sourceUrl: item.sourceUrl,
    fileUrl: item.fileUrl
  }));
  return { items, headers: result.downloadHeaders };
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

// Sync engine MUST NOT call `removeFavorite`. Those are reverse-sync
// (delete-locally → unfav-remotely), gated by the user setting and triggered
// ONLY from the HTTP DELETE /files route handler. If a future change wires
// reverse-sync into sync itself, the auto-fav marker (#66 option C) becomes a
// self-cancelling loop: scanner auto-favs → sync re-scans local file → sync
// ends up unfavoriting → next scan auto-favs again. Internal cleanup uses
// `deleteFavoriteFile`, which is filesystem+DB only.
const syncSite = async (
  userId: string,
  site: BooruSiteRecord,
  deleteMissing: boolean,
  root: string,
  onProgress: (provider: FavoriteProvider, patch: Partial<FavoriteSyncProgress>, message?: string) => void
): Promise<SyncResult> => {
  const provider = favoriteKeyForSite(site);
  const label = site.name;
  const result: SyncResult = { provider, fetched: 0, added: 0, removed: 0, skipped: 0, errors: [] };
  debugLog(`${label}: start`);
  onProgress(provider, { stage: 'fetching' }, `Fetching ${label} favorites…`);
  const fetched = await fetchSiteFavorites(site, (page, count) => {
    const message = `Fetching ${label} favorites (page ${page}, ${count} items)…`;
    onProgress(provider, { stage: 'fetching' }, message);
    debugLog(message);
  });
  const remote: FavoriteRemote[] = fetched.items;
  const headers: Record<string, string> = fetched.headers;

  result.fetched = remote.length;
  onProgress(
    provider,
    { fetched: remote.length, total: remote.length, processed: 0, stage: 'downloading' },
    `Downloading ${provider.toLowerCase()} favorites…`
  );

  const folder = await ensureFavoritesFolder(root, userId);
  const existingItems = await dataStore.listFavoriteItems(provider, userId);
  const existingById = new Map(existingItems.map((item) => [item.remoteId, item]));
  const remoteIds = new Set(remote.map((item) => item.remoteId));

  let processed = 0;
  for (const item of remote) {
    const existing = existingById.get(item.remoteId);
    const filePath = resolveFavoriteFilePath(root, item, existing?.filePath);
    const fileExists = filePath ? fs.existsSync(filePath) : false;
    if (existing && fileExists) {
      await dataStore.upsertFavoriteItem({
        provider,
        remoteId: item.remoteId,
        filePath,
        sourceUrl: item.sourceUrl,
        fileUrl: item.fileUrl
      }, userId);
      try {
        const record = await findOrScanFavoriteRecord(folder.id, filePath, userId);
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
          filePath,
          sourceUrl: item.sourceUrl,
          fileUrl: null
        }, userId);
        try {
          const record = filePath ? await findOrScanFavoriteRecord(folder.id, filePath, userId) : null;
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
      }, userId);
      result.added += 1;
      try {
        const record = await findOrScanFavoriteRecord(folder.id, filePath, userId);
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
      await deleteFavoriteFile(userId, existing);
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

const updateSyncState = (userId: string, patch: Partial<FavoriteSyncState>) => {
  const current = getSyncState(userId);
  syncStateByUser.set(userId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
};

const createProgressUpdater = (userId: string, providers: FavoriteProvider[]) => {
  const progressMap = new Map<FavoriteProvider, FavoriteSyncProgress>(
    providers.map((provider) => [provider, initProviderProgress(provider)])
  );
  return {
    update(provider: FavoriteProvider, patch: Partial<FavoriteSyncProgress>, message?: string) {
      const existing = progressMap.get(provider) ?? initProviderProgress(provider);
      const next = { ...existing, ...patch };
      progressMap.set(provider, next);
      updateSyncState(userId, {
        message: message ?? getSyncState(userId).message,
        progress: { providers: Array.from(progressMap.values()) }
      });
      if (message) debugLog(message);
    },
    snapshot() {
      return { providers: Array.from(progressMap.values()) };
    }
  };
};

const runFavoritesSync = async (userId: string, options: SyncOptions) => {
  try {
    const root = await ensureFavoritesRoot(userId);
    const syncableSites = await loadFavoriteSyncableSites(userId);
    const filterIds = options.providers?.length ? new Set(options.providers) : null;
    const sites = filterIds
      ? syncableSites.filter((site) => filterIds.has(site.id) || (site.presetKey && filterIds.has(site.presetKey)))
      : syncableSites;
    if (!sites.length) {
      updateSyncState(userId, {
        status: 'done',
        message: 'No booru sites configured for favorites sync.',
        results: [],
        progress: { providers: [] }
      });
      debugLog('sync skipped: no syncable sites');
      return;
    }
    const providerKeys = sites.map((site) => favoriteKeyForSite(site));
    const deleteMissing = options.deleteMissing ?? config.favorites.deleteMissing;
    const results: SyncResult[] = [];
    const progress = createProgressUpdater(userId, providerKeys);
    updateSyncState(userId, {
      status: 'running',
      message: 'Starting favorites sync…',
      progress: progress.snapshot(),
      results: []
    });
    debugLog('sync started');
    for (const site of sites) {
      const provider = favoriteKeyForSite(site);
      try {
        results.push(await syncSite(userId, site, deleteMissing, root, progress.update));
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
        debugLog(`${site.name}: error ${(err as Error).message}`);
      }
    }
    updateSyncState(userId, {
      status: 'done',
      message: 'Favorites sync complete.',
      results,
      progress: progress.snapshot()
    });
    debugLog('sync complete');
  } catch (err) {
    updateSyncState(userId, {
      status: 'error',
      message: `Favorites sync failed: ${(err as Error).message}`
    });
    debugLog(`sync failed: ${(err as Error).message}`);
  } finally {
    syncRunningByUser.set(userId, false);
  }
};

export const getFavoritesSyncStatus = (userId: string) => getSyncState(userId);

export const startFavoritesSync = (userId: string, options: SyncOptions = {}) => {
  if (syncRunningByUser.get(userId)) {
    return { status: 'busy', state: getSyncState(userId) };
  }
  const now = new Date().toISOString();
  updateSyncState(userId, {
    status: 'running',
    message: 'Starting favorites sync…',
    startedAt: now,
    results: [],
    progress: null
  });
  syncRunningByUser.set(userId, true);
  void runFavoritesSync(userId, options);
  return { status: 'started', state: getSyncState(userId) };
};
