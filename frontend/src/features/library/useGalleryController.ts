import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  FetchState,
  FolderDetail,
  GallerySort,
  GalleryViewProps
} from './GalleryView';

import { api, type AuthUser, type FileItem, type Folder } from '@/api';
import { useUpdateManualOrder } from '@/hooks/files';
import { makeRandomSeed, useGalleryUiStore } from '@/stores/galleryUiStore';

// ---------------------------------------------------------------------------
// Constants & helpers (verbatim from App.tsx)
// ---------------------------------------------------------------------------

const GALLERY_PAGE_SIZE = 200;
type GalleryCacheKeyOptions = {
  folderId?: string;
  sort: GallerySort;
  tagQuery: string;
  randomSeed: string;
  filterKey: string;
};

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
  /**
   * Called when a manual-order save fails to trigger a folder/file refresh.
   * Corresponds to `loadData()` inside saveManualOrder in App.tsx.
   */
  onRefreshAfterOrderFailure?: () => void;
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
   * Patch a file's isFavorite flag in place without a full refetch.
   * Also updates the hand-rolled cache.
   */
  updateFavoriteFlag: (fileId: string, isFavorite: boolean) => void;

  /**
   * Remove a file from the gallery list and update the cache.
   * Called after a delete so the gallery stays in sync without a full refetch.
   */
  removeFileFromGallery: (fileId: string) => void;

  /** Manual-order save state, surfaced for a shell-level error/loading banner */
  manualOrderState: FetchState;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGalleryController(
  input: GalleryControllerInput
): GalleryControllerOutput {
  const {
    authUser,
    folders,
    orderedFolders,
    folderDetailsById,
    isActive,
    onRefreshAfterOrderFailure
  } = input;

  const updateManualOrderMutation = useUpdateManualOrder();

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
  const [manualOrderState, setManualOrderState] = useState<FetchState>({
    loading: false,
    error: null
  });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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

  /** Prevents click-to-open triggering immediately after a drag-drop */
  const dragActiveRef = useRef<boolean>(false);

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const galleryMediaFilter =
    galleryFilters.photos && !galleryFilters.videos
      ? 'IMAGE'
      : galleryFilters.videos && !galleryFilters.photos
        ? 'VIDEO'
        : 'ALL';

  const galleryFavoritesOnly = galleryFilters.favorites;

  const galleryFilterLabels: string[] = [];
  if (galleryFilters.photos) galleryFilterLabels.push('Photos');
  if (galleryFilters.videos) galleryFilterLabels.push('Videos');
  if (galleryFilters.favorites) galleryFilterLabels.push('Favorites');
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
      const shouldPaginate = gallerySort !== 'manual';
      const allowCache = !isRandom;
      const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: galleryTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
      const cached = allowCache ? galleryCacheRef.current.get(cacheKey) : null;
      if (options.reset && cached) {
        setGalleryFiles(cached.files);
        setGalleryTotal(cached.total);
        setGalleryOffset(cached.offset);
        setGalleryHasMore(cached.hasMore);
      }
      const offset = shouldPaginate
        ? options.reset
          ? 0
          : galleryOffsetRef.current
        : undefined;
      const limit = shouldPaginate ? GALLERY_PAGE_SIZE : undefined;
      setGalleryPageState({ loading: true, error: null });
      try {
        const data = await api.getFiles(
          galleryFolderId || undefined,
          gallerySort,
          galleryTagQuery,
          {
            limit,
            offset,
            seed: isRandom ? galleryRandomSeed : undefined,
            mediaType:
              galleryMediaFilter === 'ALL' ? undefined : galleryMediaFilter,
            favoritesOnly: galleryFavoritesOnly ? true : undefined,
            signal: controller.signal
          }
        );
        if (requestId !== galleryRequestRef.current.id) return;
        const nextFiles = data.files;
        const total = data.total ?? nextFiles.length;
        const baseFiles =
          options.reset || !shouldPaginate
            ? []
            : (cached?.files ?? galleryFilesRef.current);
        const updatedFiles =
          options.reset || !shouldPaginate
            ? nextFiles
            : [...baseFiles, ...nextFiles];
        setGalleryTotal(total);
        setGalleryFiles(updatedFiles);
        const nextOffset = shouldPaginate
          ? (offset ?? 0) + nextFiles.length
          : nextFiles.length;
        setGalleryOffset(nextOffset);
        setGalleryHasMore(shouldPaginate ? nextOffset < total : false);
        if (allowCache) {
          galleryCacheRef.current.set(cacheKey, {
            files: updatedFiles,
            total,
            offset: nextOffset,
            hasMore: shouldPaginate ? nextOffset < total : false
          });
        }
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
      galleryFavoritesOnly,
      galleryFolderId,
      galleryMediaFilter,
      galleryRandomSeed,
      gallerySort,
      galleryTagQuery
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

  // Drop the page cache when the media/favorites filter changes. The cache is
  // keyed by filter combination, so without this every toggle leaves its old
  // entry behind and the Map grows unbounded over a long session.
  useEffect(() => {
    galleryCacheRef.current.clear();
  }, [galleryMediaFilter, galleryFavoritesOnly]);

  // Refetch on gallery params change — only when gallery is active (verbatim logic)
  useEffect(() => {
    if (!authUser) return;
    if (!isActive) return;
    const isRandom = gallerySort === 'random';
    const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
    const cacheKey = buildGalleryCacheKey({
      folderId: galleryFolderId,
      sort: gallerySort,
      tagQuery: galleryTagQuery,
      randomSeed: galleryRandomSeed,
      filterKey
    });
    const cached = isRandom ? null : galleryCacheRef.current.get(cacheKey);
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
    galleryFavoritesOnly,
    galleryFolderId,
    galleryMediaFilter,
    galleryRandomSeed,
    gallerySort,
    galleryTagQuery,
    loadGalleryPage
  ]);

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

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /** Apply a new sort, generate a fresh random seed if needed, persist to localStorage */
  const applyGallerySort = useCallback(
    (sort: GallerySort) => {
      if (sort === 'random') {
        setGalleryRandomSeed(makeRandomSeed());
      }
      setGallerySort(sort);
    },
    [setGalleryRandomSeed, setGallerySort]
  );

  const saveManualOrder = useCallback(
    async (next: FileItem[]) => {
      setManualOrderState({ loading: true, error: null });
      try {
        await updateManualOrderMutation.mutateAsync(
          next.map((file) => file.id)
        );
        setManualOrderState({ loading: false, error: null });
      } catch (err) {
        setManualOrderState({
          loading: false,
          error: (err as Error).message
        });
        onRefreshAfterOrderFailure?.();
      }
    },
    [updateManualOrderMutation, onRefreshAfterOrderFailure]
  );

  /** Splice item from `fromId` position to `toId` position, then persist */
  const moveManualItem = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      setGalleryFiles((prev) => {
        const fromIndex = prev.findIndex((item) => item.id === fromId);
        const toIndex = prev.findIndex((item) => item.id === toId);
        if (fromIndex === -1 || toIndex === -1) return prev;
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        void saveManualOrder(next);
        return next;
      });
    },
    [saveManualOrder]
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

  /** Patch isFavorite in gallery list + hand-rolled cache without refetch */
  const updateFavoriteFlag = useCallback(
    (fileId: string, isFavorite: boolean) => {
      const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: galleryTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
      const removeFromFavoritesView =
        galleryFavoritesOnly &&
        !isFavorite &&
        galleryFilesRef.current.some((file) => file.id === fileId);
      setGalleryFiles((prev) => {
        const updated = prev.map((file) =>
          file.id === fileId ? { ...file, isFavorite } : file
        );
        if (galleryFavoritesOnly && !isFavorite) {
          return updated.filter((file) => file.id !== fileId);
        }
        return updated;
      });
      if (removeFromFavoritesView) {
        setGalleryTotal((prev) => (prev > 0 ? prev - 1 : 0));
        setGalleryOffset((prev) => Math.max(0, prev - 1));
      }
      const cached =
        gallerySort !== 'random' ? galleryCacheRef.current.get(cacheKey) : null;
      if (cached) {
        const existedInCache = cached.files.some((file) => file.id === fileId);
        let nextFiles = cached.files.map((file) =>
          file.id === fileId ? { ...file, isFavorite } : file
        );
        let nextTotal = cached.total;
        let nextOffset = cached.offset;
        let nextHasMore = cached.hasMore;
        if (galleryFavoritesOnly && !isFavorite) {
          nextFiles = nextFiles.filter((file) => file.id !== fileId);
          if (existedInCache) {
            nextTotal = nextTotal > 0 ? nextTotal - 1 : 0;
            nextOffset = Math.max(0, nextOffset - 1);
            nextHasMore = cached.hasMore ? nextOffset < nextTotal : false;
          }
        }
        galleryCacheRef.current.set(cacheKey, {
          ...cached,
          files: nextFiles,
          total: nextTotal,
          offset: nextOffset,
          hasMore: nextHasMore
        });
      }
    },
    [
      galleryFavoritesOnly,
      galleryFolderId,
      galleryMediaFilter,
      galleryRandomSeed,
      gallerySort,
      galleryTagQuery
    ]
  );

  /** Remove a file from the gallery list and update the cache after delete */
  const removeFileFromGallery = useCallback(
    (fileId: string) => {
      setGalleryFiles((prev) => prev.filter((file) => file.id !== fileId));
      setGalleryTotal((prev) => (prev > 0 ? prev - 1 : 0));
      setGalleryOffset((prev) => Math.max(0, prev - 1));
      const filterKey = `${galleryMediaFilter}:${galleryFavoritesOnly ? 'fav' : 'all'}`;
      const cacheKey = buildGalleryCacheKey({
        folderId: galleryFolderId,
        sort: gallerySort,
        tagQuery: galleryTagQuery,
        randomSeed: galleryRandomSeed,
        filterKey
      });
      const cached =
        gallerySort !== 'random' ? galleryCacheRef.current.get(cacheKey) : null;
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
      galleryFavoritesOnly,
      galleryFolderId,
      galleryMediaFilter,
      galleryRandomSeed,
      gallerySort,
      galleryTagQuery
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
    galleryFilters,
    isGalleryFilterOpen,
    galleryTagInput,
    galleryFilterLabel,
    galleryCountText,
    selectedGalleryFolder,
    orderedFolders,
    folderDetailsById,
    draggingId,
    dragOverId,
    // refs
    galleryFilterRef,
    galleryLoadMoreRef,
    dragActiveRef,
    // callbacks
    onFolderChange: setGalleryFolderId,
    onTagInputChange: setGalleryTagInput,
    onTagQueryClear: () => setGalleryTagQuery(''),
    onFilterChange: (patch) =>
      setGalleryFilters((prev) => ({ ...prev, ...patch })),
    onFilterClose: () => setIsGalleryFilterOpen(false),
    onFilterOpenToggle: () => setIsGalleryFilterOpen((prev) => !prev),
    onSortChange: applyGallerySort,
    onLoadMore: () => void loadGalleryPage(),
    onMoveManualItem: moveManualItem,
    onDraggingChange: setDraggingId,
    onDragOverChange: setDragOverId
  };

  return {
    viewProps,
    galleryFiles,
    galleryHasMore,
    selectedFileIndex,
    goRelative,
    resetGallery,
    reloadGallery,
    updateFavoriteFlag,
    removeFileFromGallery,
    manualOrderState
  };
}
