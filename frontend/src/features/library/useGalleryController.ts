import { useLocation } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { GALLERY_PAGE_SIZE, resetFetchLimit } from './galleryPaging';
import type {
  FetchState,
  FolderDetail,
  GallerySort,
  GalleryViewProps
} from './GalleryView';

import { api, type AuthUser, type FileItem, type Folder } from '@/api';
import { restoreScrollTo } from '@/features/file-detail/restoreScrollTo';
import { applyBlacklistToQuery } from '@/features/settings/blacklist';
import { useBlacklistSettings, useExtraSettings } from '@/hooks/settings';
import { makeRandomSeed, useGalleryUiStore } from '@/stores/galleryUiStore';

// ---------------------------------------------------------------------------
// Constants & helpers (verbatim from App.tsx)
// ---------------------------------------------------------------------------

type GalleryCacheKeyOptions = {
  folderId?: string;
  sort: GallerySort;
  tagQuery: string;
  randomSeed: string;
  filterKey: string;
};

/**
 * A random order is as cacheable as any other because the seed is part of
 * the key: a new seed is a different key, never a stale hit. Skipping the
 * cache here meant every return from the detail view refetched page 1 alone
 * and threw away everything scrolled past it (issue #304).
 */
const buildGalleryCacheKey = ({
  folderId,
  sort,
  tagQuery,
  randomSeed,
  filterKey
}: GalleryCacheKeyOptions): string => {
  const folderKey = folderId || 'all';
  return sort === 'random'
    ? `${folderKey}:${sort}:${tagQuery}:${randomSeed}:${filterKey}`
    : `${folderKey}:${sort}:${tagQuery}:${filterKey}`;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GalleryControllerInput = {
  /** Currently authenticated user — null while logged out */
  authUser: AuthUser | null;
  /** All folders from useFolders */
  folders: Folder[];
  /** Folders sorted for display (pre-sorted by App / folders controller) */
  orderedFolders: Folder[];
  /** Folder metadata map keyed by folder id */
  folderDetailsById: Map<string, FolderDetail>;
  /**
   * Whether the gallery view is currently active.
   * The controller skips fetch effects when false, mirroring the
   * `if (viewMode !== 'gallery') return` guards in App.tsx.
   */
  isActive: boolean;
};

export type GalleryControllerOutput = {
  /**
   * Props for <GalleryView /> minus `onFileOpen`, which the route owns (it
   * also drives URL navigation). Spread directly onto the component.
   */
  viewProps: Omit<GalleryViewProps, 'onFileOpen'>;

  // --- cross-feature coordination pieces ---

  /** Current gallery file list (for file-detail to compute prev/next) */
  galleryFiles: FileItem[];

  /** Whether there are more pages to load */
  galleryHasMore: boolean;

  /**
   * Returns the index of `id` inside the current gallery file list.
   * Returns -1 if not found.
   */
  selectedFileIndex: (id: string) => number;

  /**
   * Navigate to the file `delta` positions away from `currentId`.
   * Loads the next page automatically when delta > 0 and no next file is loaded.
   */
  goRelative: (currentId: string, delta: number) => Promise<void>;

  /** Reset gallery to empty + reload from page 0 */
  resetGallery: () => void;

  /** Reload gallery from page 0, keeping cached data visible while loading */
  reloadGallery: () => Promise<void>;

  /**
   * Patch a file's vote score/cooldown in place without a full refetch.
   * Also updates the hand-rolled cache.
   */
  updateVote: (
    fileId: string,
    vote: { voteScore: number; nextVoteAt: string | null }
  ) => void;

  /**
   * Remove a file from the gallery list and update the cache.
   * Called after a delete so the gallery stays in sync without a full refetch.
   */
  removeFileFromGallery: (fileId: string) => void;
  restoreFileToGallery: (file: FileItem, index: number) => void;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGalleryController(
  input: GalleryControllerInput
): GalleryControllerOutput {
  const { authUser, folders, orderedFolders, folderDetailsById, isActive } =
    input;

  const { voteSystemEnabled } = useExtraSettings();
  const blacklist = useBlacklistSettings();

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const [galleryFiles, setGalleryFiles] = useState<FileItem[]>([]);
  const [galleryTotal, setGalleryTotal] = useState(0);
  const [galleryOffset, setGalleryOffset] = useState(0);
  const [galleryHasMore, setGalleryHasMore] = useState(false);
  const [galleryPageState, setGalleryPageState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const galleryFolderId = useGalleryUiStore((state) => state.galleryFolderId);
  const gallerySort = useGalleryUiStore((state) => state.gallerySort);
  const galleryFilters = useGalleryUiStore((state) => state.galleryFilters);
  const isGalleryFilterOpen = useGalleryUiStore(
    (state) => state.isGalleryFilterOpen
  );
  const galleryRandomSeed = useGalleryUiStore(
    (state) => state.galleryRandomSeed
  );
  const galleryTagInput = useGalleryUiStore((state) => state.galleryTagInput);
  const galleryTagQuery = useGalleryUiStore((state) => state.galleryTagQuery);
  // The blacklist rides along inside the tag query rather than filtering the
  // results here: the server already knows how to exclude terms, and going
  // through the query keeps `total` and the page cache honest.
  const searchTagQuery = useMemo(
    () =>
      blacklist.applyToGallery
        ? applyBlacklistToQuery(galleryTagQuery, blacklist.tags)
        : galleryTagQuery,
    [blacklist.applyToGallery, blacklist.tags, galleryTagQuery]
  );

  const setGalleryFolderId = useGalleryUiStore(
    (state) => state.setGalleryFolderId
  );
  const setGallerySort = useGalleryUiStore((state) => state.setGallerySort);
  const setGalleryFilters = useGalleryUiStore(
    (state) => state.setGalleryFilters
  );
  const setIsGalleryFilterOpen = useGalleryUiStore(
    (state) => state.setIsGalleryFilterOpen
  );
  const setGalleryRandomSeed = useGalleryUiStore(
    (state) => state.setGalleryRandomSeed
  );
  const setGalleryTagInput = useGalleryUiStore(
    (state) => state.setGalleryTagInput
  );
  const setGalleryTagQuery = useGalleryUiStore(
    (state) => state.setGalleryTagQuery
  );

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  /** Hand-rolled LRU-style page cache keyed by buildGalleryCacheKey */
  const galleryCacheRef = useRef<
    Map<
      string,
      { files: FileItem[]; total: number; offset: number; hasMore: boolean }
    >
  >(new Map());

  /** Stable closure refs for loadGalleryPage (avoids stale closures) */
  const galleryFilesRef = useRef<FileItem[]>([]);
  const galleryOffsetRef = useRef(0);

  /** Boolean lock — prevents parallel page loads */
  const galleryLoadingRef = useRef(false);

  /** Tracks in-flight fetch: id for stale-response detection, controller to abort */
  const galleryRequestRef = useRef<{
    id: number;
    controller: AbortController | null;
  }>({ id: 0, controller: null });

  /** DOM ref for click-outside detection on the filter popover */
  const galleryFilterRef = useRef<HTMLDivElement | null>(null);

  /** IntersectionObserver sentinel for infinite scroll */
  const galleryLoadMoreRef = useRef<HTMLDivElement | null>(null);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const galleryMediaFilter =
    galleryFilters.photos && !galleryFilters.videos
      ? 'IMAGE'
      : galleryFilters.videos && !galleryFilters.photos
        ? 'VIDEO'
        : 'ALL';

  const galleryFilterLabels: string[] = [];
  if (galleryFilters.photos) galleryFilterLabels.push('Photos');
  if (galleryFilters.videos) galleryFilterLabels.push('Videos');
  const galleryFilterLabel =
    galleryFilterLabels.length === 0
      ? 'No filters'
      : `Filters (${galleryFilterLabels.length}): ${galleryFilterLabels.join(', ')}`;

  const galleryCountText = galleryTotal
    ? `${galleryTotal}`
    : `${galleryFiles.length}`;

  const folderMap = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders]
  );

  const selectedGalleryFolder = galleryFolderId
    ? (folderMap.get(galleryFolderId) ?? null)
    : null;

  // -------------------------------------------------------------------------
  // Stable-closure sync effects (verbatim from App.tsx)
  // -------------------------------------------------------------------------

  useEffect(() => {
    galleryFilesRef.current = galleryFiles;
  }, [galleryFiles]);

  useEffect(() => {
    galleryOffsetRef.current = galleryOffset;
  }, [galleryOffset]);

  // -------------------------------------------------------------------------
  // Core fetch — loadGalleryPage (verbatim from App.tsx)
  // -------------------------------------------------------------------------

  const loadGalleryPage = useCallback(
    async (options: { reset?: boolean } = {}) => {
      if (galleryLoadingRef.current && !options.reset) return;
      if (options.reset && galleryRequestRef.current.controller) {
        galleryRequestRef.current.controller.abort();
      }
      const requestId = galleryRequestRef.current.id + 1;
      const controller = new AbortController();
      galleryRequestRef.current = { id: requestId, controller };
      galleryLoadingRef.current = true;
      const isRandom = gallerySort === 'random';
      const filterKey = galleryMediaFilter;
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: searchTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
      const cached = galleryCacheRef.current.get(cacheKey);
      if (options.reset && cached) {
        setGalleryFiles(cached.files);
        setGalleryTotal(cached.total);
        setGalleryOffset(cached.offset);
        setGalleryHasMore(cached.hasMore);
      }
      const offset = options.reset ? 0 : galleryOffsetRef.current;
      // A reset over a cached list is a refresh of what the reader is already
      // looking at, so it asks back to the depth that list reached rather
      // than for a single page (issue #304).
      const limit = options.reset
        ? resetFetchLimit(cached?.offset ?? 0)
        : GALLERY_PAGE_SIZE;
      setGalleryPageState({ loading: true, error: null });
      try {
        const data = await api.getFiles(
          galleryFolderId || undefined,
          gallerySort,
          searchTagQuery,
          {
            limit,
            offset,
            seed: isRandom ? galleryRandomSeed : undefined,
            mediaType:
              galleryMediaFilter === 'ALL' ? undefined : galleryMediaFilter,
            signal: controller.signal
          }
        );
        if (requestId !== galleryRequestRef.current.id) return;
        const nextFiles = data.files;
        const total = data.total ?? nextFiles.length;
        const baseFiles = options.reset
          ? []
          : (cached?.files ?? galleryFilesRef.current);
        const updatedFiles = options.reset
          ? nextFiles
          : [...baseFiles, ...nextFiles];
        setGalleryTotal(total);
        setGalleryFiles(updatedFiles);
        const nextOffset = offset + nextFiles.length;
        setGalleryOffset(nextOffset);
        setGalleryHasMore(nextOffset < total);
        galleryCacheRef.current.set(cacheKey, {
          files: updatedFiles,
          total,
          offset: nextOffset,
          hasMore: nextOffset < total
        });
        setGalleryPageState({ loading: false, error: null });
      } catch (err) {
        if (requestId !== galleryRequestRef.current.id) return;
        if ((err as Error).name === 'AbortError') {
          setGalleryPageState({ loading: false, error: null });
          return;
        }
        setGalleryPageState({
          loading: false,
          error: (err as Error).message
        });
      } finally {
        if (requestId === galleryRequestRef.current.id) {
          galleryLoadingRef.current = false;
        }
      }
    },

    [
      galleryFolderId,
      galleryMediaFilter,
      galleryRandomSeed,
      gallerySort,
      searchTagQuery
    ]
  );

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  // Debounce tag input → tagQuery (verbatim)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handle = window.setTimeout(() => {
      setGalleryTagQuery(galleryTagInput.trim());
    }, 300);
    return () => window.clearTimeout(handle);
  }, [galleryTagInput, setGalleryTagQuery]);

  // Click-outside / Escape to close filter popover
  useEffect(() => {
    if (!isGalleryFilterOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && galleryFilterRef.current?.contains(target)) return;
      setIsGalleryFilterOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsGalleryFilterOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKey);
    };
  }, [isGalleryFilterOpen, setIsGalleryFilterOpen]);

  // Clear folder selection when the folder is removed (verbatim)
  useEffect(() => {
    if (galleryFolderId && !folderMap.has(galleryFolderId)) {
      setGalleryFolderId('');
    }
  }, [folderMap, galleryFolderId, setGalleryFolderId]);

  // Drop the page cache when the media filter changes. The cache is keyed by
  // filter combination, so without this every toggle leaves its old entry
  // behind and the Map grows unbounded over a long session.
  useEffect(() => {
    galleryCacheRef.current.clear();
  }, [galleryMediaFilter]);

  // Refetch on gallery params change — only when gallery is active (verbatim logic)
  useEffect(() => {
    if (!authUser) return;
    if (!isActive) return;
    // The blacklist decides what the query excludes, so fetching before it
    // lands would paint a page of files it exists to hide.
    if (!blacklist.loaded) return;
    const filterKey = galleryMediaFilter;
    const cacheKey = buildGalleryCacheKey({
      folderId: galleryFolderId,
      sort: gallerySort,
      tagQuery: searchTagQuery,
      randomSeed: galleryRandomSeed,
      filterKey
    });
    const cached = galleryCacheRef.current.get(cacheKey);
    if (cached) {
      setGalleryFiles(cached.files);
      setGalleryOffset(cached.offset);
      setGalleryHasMore(cached.hasMore);
      setGalleryTotal(cached.total);
    } else {
      setGalleryFiles([]);
      setGalleryOffset(0);
      setGalleryHasMore(false);
      setGalleryTotal(0);
    }
    void loadGalleryPage({ reset: true });
  }, [
    authUser,
    isActive,
    blacklist.loaded,
    galleryFolderId,
    galleryMediaFilter,
    galleryRandomSeed,
    gallerySort,
    searchTagQuery,
    loadGalleryPage
  ]);

  // -------------------------------------------------------------------------
  // Effects: coming back to the gallery
  // -------------------------------------------------------------------------

  /**
   * The files survive a trip to another page on their own — this controller
   * lives in the shell and never unmounts — but the window does not keep its
   * offset, so coming back landed at the top of a list the reader had
   * already scrolled through.
   *
   * Opening a file is not a page change: the detail view has its own restore
   * and scrolls the window itself, so nothing is recorded while it is up.
   */
  const onGalleryRoute = useLocation({
    select: (state) => state.pathname === '/app/gallery'
  });
  const galleryDetailOpen = useLocation({
    select: (state) => Boolean((state.search as { fileId?: string }).fileId)
  });
  const galleryPlaceRef = useRef(0);
  useEffect(() => {
    if (!onGalleryRoute || galleryDetailOpen) return;
    const onScroll = () => {
      galleryPlaceRef.current = window.scrollY;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [onGalleryRoute, galleryDetailOpen]);

  /**
   * Stamped with a counter rather than held as a bare number: leaving and
   * coming back to the same offset twice would otherwise be no state change
   * at all, and the second return would not restore.
   */
  const [galleryRestore, setGalleryRestore] = useState<{
    top: number;
    tick: number;
  } | null>(null);
  const wasOnGalleryRef = useRef(onGalleryRoute);
  useEffect(() => {
    if (onGalleryRoute === wasOnGalleryRef.current) return;
    wasOnGalleryRef.current = onGalleryRoute;
    if (!onGalleryRoute) return;
    setGalleryRestore((prev) => ({
      top: galleryPlaceRef.current,
      tick: (prev?.tick ?? 0) + 1
    }));
  }, [onGalleryRoute]);

  // Its own effect, so StrictMode's second pass restarts the attempt rather
  // than cancelling it.
  useEffect(() => {
    if (!galleryRestore) return;
    return restoreScrollTo(galleryRestore.top);
  }, [galleryRestore]);

  // Persist sort to localStorage (verbatim via applyGallerySort below)
  // The write happens inside the sort handler, not an effect, matching App.tsx.

  // IntersectionObserver — load-more sentinel (verbatim)
  useEffect(() => {
    if (!isActive) return;
    if (!galleryHasMore) return;
    const target = galleryLoadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadGalleryPage();
        }
      },
      { rootMargin: '400px' }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [galleryHasMore, isActive, loadGalleryPage]);

  // "Rated" disappears with the vote system, so a stored preference for it
  // has to fall back to something that still exists.
  useEffect(() => {
    if (!voteSystemEnabled && gallerySort === 'rated') {
      setGallerySort('mtime_desc');
    }
  }, [gallerySort, setGallerySort, voteSystemEnabled]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /** Apply a new sort, generate a fresh random seed if needed, persist to localStorage */
  const applyGallerySort = useCallback(
    (sort: GallerySort) => {
      if (sort === 'random') {
        // A new seed is a new order, so the pages cached under the old one
        // are unreachable from here on. Dropping them is what keeps the
        // cache from growing by a whole library every time Random is picked.
        galleryCacheRef.current.clear();
        setGalleryRandomSeed(makeRandomSeed());
      }
      setGallerySort(sort);
    },
    [setGalleryRandomSeed, setGallerySort]
  );

  /** Navigate delta positions relative to currentId; loads next page when needed */
  const goRelative = useCallback(
    async (currentId: string, delta: number) => {
      const idx = galleryFilesRef.current.findIndex((f) => f.id === currentId);
      if (idx === -1) return;
      const next = galleryFilesRef.current[idx + delta];
      if (next) {
        // Caller (App.tsx / file-detail controller) handles setSelectedFile
        return;
      }
      if (delta > 0 && galleryHasMore) {
        await loadGalleryPage();
      }
    },
    [galleryHasMore, loadGalleryPage]
  );

  /** Patch a file's vote in the gallery list + hand-rolled cache, no refetch */
  const updateVote = useCallback(
    (
      fileId: string,
      vote: { voteScore: number; nextVoteAt: string | null }
    ) => {
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: searchTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey: galleryMediaFilter
      });
      const patch = (file: FileItem) =>
        file.id === fileId ? { ...file, ...vote } : file;
      setGalleryFiles((prev) => prev.map(patch));
      const cached = galleryCacheRef.current.get(cacheKey);
      if (cached) {
        galleryCacheRef.current.set(cacheKey, {
          ...cached,
          files: cached.files.map(patch)
        });
      }
    },
    [
      galleryFolderId,
      galleryMediaFilter,
      galleryRandomSeed,
      gallerySort,
      searchTagQuery
    ]
  );

  /** Remove a file from the gallery list and update the cache after delete */
  const removeFileFromGallery = useCallback(
    (fileId: string) => {
      setGalleryFiles((prev) => prev.filter((file) => file.id !== fileId));
      setGalleryTotal((prev) => (prev > 0 ? prev - 1 : 0));
      setGalleryOffset((prev) => Math.max(0, prev - 1));
      const filterKey = galleryMediaFilter;
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: searchTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
      const cached = galleryCacheRef.current.get(cacheKey);
      if (cached) {
        const nextFiles = cached.files.filter((file) => file.id !== fileId);
        const nextTotal = cached.total > 0 ? cached.total - 1 : 0;
        const nextOffset = Math.max(0, cached.offset - 1);
        const nextHasMore = cached.hasMore ? nextOffset < nextTotal : false;
        galleryCacheRef.current.set(cacheKey, {
          files: nextFiles,
          total: nextTotal,
          offset: nextOffset,
          hasMore: nextHasMore
        });
      }
    },
    [
      galleryFolderId,
      galleryMediaFilter,
      galleryRandomSeed,
      gallerySort,
      searchTagQuery
    ]
  );

  /**
   * Puts a file back exactly where `removeFileFromGallery` took it from, for
   * the undo window a delete gets before it is actually sent (issue #305).
   */
  const restoreFileToGallery = useCallback(
    (file: FileItem, index: number) => {
      const insert = (files: FileItem[]): FileItem[] => {
        if (files.some((existing) => existing.id === file.id)) return files;
        const next = files.slice();
        next.splice(Math.min(Math.max(index, 0), next.length), 0, file);
        return next;
      };
      setGalleryFiles(insert);
      setGalleryTotal((prev) => prev + 1);
      setGalleryOffset((prev) => prev + 1);
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: searchTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey: galleryMediaFilter
      });
      const cached = galleryCacheRef.current.get(cacheKey);
      if (cached) {
        galleryCacheRef.current.set(cacheKey, {
          ...cached,
          files: insert(cached.files),
          total: cached.total + 1,
          offset: cached.offset + 1
        });
      }
    },
    [
      galleryFolderId,
      galleryMediaFilter,
      galleryRandomSeed,
      gallerySort,
      searchTagQuery
    ]
  );

  const resetGallery = useCallback(() => {
    galleryCacheRef.current.clear();
    setGalleryFiles([]);
    setGalleryTotal(0);
    setGalleryOffset(0);
    setGalleryHasMore(false);
  }, []);

  const reloadGallery = useCallback(async () => {
    await loadGalleryPage({ reset: true });
  }, [loadGalleryPage]);

  const selectedFileIndex = useCallback(
    (id: string) => galleryFilesRef.current.findIndex((file) => file.id === id),
    []
  );

  // -------------------------------------------------------------------------
  // Assemble GalleryViewProps
  // -------------------------------------------------------------------------

  const viewProps: Omit<GalleryViewProps, 'onFileOpen'> = {
    // state
    galleryFolderId,
    galleryFiles,
    galleryHasMore,
    galleryPageState,
    gallerySort,
    voteSystemEnabled,
    galleryFilters,
    isGalleryFilterOpen,
    galleryTagInput,
    galleryFilterLabel,
    galleryCountText,
    selectedGalleryFolder,
    orderedFolders,
    folderDetailsById,
    // refs
    galleryFilterRef,
    galleryLoadMoreRef,
    // callbacks
    onFolderChange: setGalleryFolderId,
    onTagInputChange: setGalleryTagInput,
    onTagQueryClear: () => setGalleryTagQuery(''),
    onFilterChange: (patch) =>
      setGalleryFilters((prev) => ({ ...prev, ...patch })),
    onFilterClose: () => setIsGalleryFilterOpen(false),
    onFilterOpenToggle: () => setIsGalleryFilterOpen((prev) => !prev),
    onSortChange: applyGallerySort,
    onLoadMore: () => void loadGalleryPage()
  };

  return {
    viewProps,
    galleryFiles,
    galleryHasMore,
    selectedFileIndex,
    goRelative,
    resetGallery,
    reloadGallery,
    updateVote,
    removeFileFromGallery,
    restoreFileToGallery
  };
}
