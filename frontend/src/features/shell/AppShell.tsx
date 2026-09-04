import { useQueryClient } from '@tanstack/react-query';
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useRouter,
  useSearch
} from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef
} from 'react';

import { AppTabBar } from './AppTabBar';
import { getDetailUrlSyncAction } from './galleryDetailSync';

import { authRequiredEvent, type DuplicateFile, type FileItem } from '@/api';
import { useDuplicatesController } from '@/features/duplicates/useDuplicatesController';
import { useSauceFavoritesController } from '@/features/favorites-sauce/useSauceFavoritesController';
import { useFileDetailController } from '@/features/file-detail/useFileDetailController';
import { useFoldersController } from '@/features/folders/useFoldersController';
import { useGalleryController } from '@/features/library/useGalleryController';
import { useCurrentUser, useLogout } from '@/hooks/auth';
import { useExtraSettings } from '@/hooks/settings';
import { queryKeys } from '@/lib/query-keys';
import { useDuplicatesUiStore } from '@/stores/duplicatesUiStore';
import { useExploreUiStore } from '@/stores/exploreUiStore';
import { useGalleryUiStore } from '@/stores/galleryUiStore';
import { useSettingsUiStore } from '@/stores/settingsUiStore';

type AppShellContextValue = {
  authUser: NonNullable<ReturnType<typeof useCurrentUser>['data']>;
  logoutPending: boolean;
  logoutError: string | null;
  logout: () => Promise<void>;
  foldersCtl: ReturnType<typeof useFoldersController>;
  sauceFavoritesCtl: ReturnType<typeof useSauceFavoritesController>;
  duplicatesCtl: ReturnType<typeof useDuplicatesController>;
  galleryCtl: ReturnType<typeof useGalleryController>;
  fileDetailCtl: ReturnType<typeof useFileDetailController>;
  openGalleryFile: (file: FileItem) => void;
};

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShellContext() {
  const value = useContext(AppShellContext);
  if (!value) {
    throw new Error('AppShell context missing');
  }
  return value;
}

export function AppShell() {
  const queryClient = useQueryClient();
  const authQuery = useCurrentUser();
  const logoutMutation = useLogout();
  const navigate = useNavigate();
  const exploreNav = useExploreUiStore((state) => state.detailNav);
  const resetGalleryUiState = useGalleryUiStore(
    (state) => state.resetGalleryUiState
  );
  const resetDuplicatesUiState = useDuplicatesUiStore(
    (state) => state.resetDuplicatesUiState
  );
  const resetSettingsUiState = useSettingsUiStore(
    (state) => state.resetSettingsUiState
  );

  const selectedFileRef = useRef<FileItem | null>(null);
  const openFileRef = useRef<(file: FileItem) => void>(() => undefined);
  const galleryCtlRef = useRef<ReturnType<typeof useGalleryController> | null>(
    null
  );
  const fileDetailCtlRef = useRef<ReturnType<
    typeof useFileDetailController
  > | null>(null);

  const authUser = authQuery.data;
  if (!authUser) {
    throw new Error('Protected app shell rendered without authenticated user');
  }

  const libraryRoot = authUser.libraryRoot ?? '';

  const sauceFavoritesCtl = useSauceFavoritesController({
    authUser
  });

  const foldersCtl = useFoldersController({
    authUser,
    libraryRoot,
    favoritesSettings: sauceFavoritesCtl.favoritesRootSettings,
    favoritesSettingsState: sauceFavoritesCtl.favoritesRootSettingsState,
    onUpdateFavoritesRoot: (folderId) =>
      void sauceFavoritesCtl.updateFavoritesRoot(folderId),
    uploadInputAccept:
      '.jpg,.jpeg,.png,.gif,.bmp,.webp,.tif,.tiff,.avif,.mp4,.mov,.avi,.mkv,.webm,.wmv,.flv,.m4v',
    onUploadComplete: () => void galleryCtlRef.current?.reloadGallery(),
    onScanFinished: () => void galleryCtlRef.current?.reloadGallery()
  });

  const { gamesTabEnabled } = useExtraSettings();

  const duplicatesCtl = useDuplicatesController({
    authUser
  });

  const galleryCtl = useGalleryController({
    authUser,
    folders: foldersCtl.folders,
    orderedFolders: foldersCtl.orderedFolders,
    folderDetailsById: foldersCtl.folderDetailsById,
    isActive: true
  });
  galleryCtlRef.current = galleryCtl;

  const goRelativeWrapper = useCallback(
    async (delta: number) => {
      const current = selectedFileRef.current;
      if (!current) return;
      const idx = galleryCtl.selectedFileIndex(current.id);
      if (idx === -1) return;
      const nextFile = galleryCtl.galleryFiles[idx + delta];
      if (nextFile) {
        openFileRef.current(nextFile);
        return;
      }
      if (delta > 0 && galleryCtl.galleryHasMore) {
        await galleryCtl.goRelative(current.id, delta);
        const freshCurrent = selectedFileRef.current;
        if (!freshCurrent) return;
        const freshIndex = galleryCtl.selectedFileIndex(freshCurrent.id);
        if (freshIndex === -1) return;
        const loadedNeighbor = galleryCtl.galleryFiles[freshIndex + delta];
        if (loadedNeighbor) {
          openFileRef.current(loadedNeighbor);
        }
      }
    },
    [galleryCtl]
  );

  const selectedFileId = selectedFileRef.current?.id;
  const currentIndex =
    selectedFileId != null ? galleryCtl.selectedFileIndex(selectedFileId) : -1;

  // --- detail view URL state ------------------------------------------------
  // The gallery route owns `fileId` and `fs`, but the detail controller lives
  // here (logout and the duplicates view both close files), so read the search
  // params loosely rather than binding to the gallery route.
  const router = useRouter();
  const { pathname } = useLocation();
  const search = useSearch({ strict: false }) as {
    fileId?: string;
    fs?: boolean;
  };
  const urlFileId = search.fileId;
  const fullscreen = Boolean(search.fs);
  const onGalleryRoute = pathname === '/app/gallery';

  // Track whether *we* pushed the entry, so closing pops it instead of
  // stacking a replace on top — otherwise open/close cycles pile up history
  // entries and the back gesture needs one press per cycle to escape.
  const detailEntryPushedRef = useRef(false);
  const fullscreenEntryPushedRef = useRef(false);

  // Only react to the URL *losing* the state (back button, or a replace that
  // dropped our entry). Checking during render would clobber the flag on the
  // re-render that happens between the click and the navigation committing.
  useEffect(() => {
    if (!urlFileId) detailEntryPushedRef.current = false;
  }, [urlFileId]);

  useEffect(() => {
    if (!fullscreen) fullscreenEntryPushedRef.current = false;
  }, [fullscreen]);

  const closeGalleryDetailUrl = useCallback(() => {
    if (detailEntryPushedRef.current) {
      detailEntryPushedRef.current = false;
      router.history.back();
      return;
    }
    void navigate({
      to: '/app/gallery',
      replace: true,
      search: { fileId: undefined, fs: undefined }
    });
  }, [navigate, router]);

  const setFullscreen = useCallback(
    (next: boolean) => {
      // The URL-sync effect writes fileId asynchronously after a file opens,
      // so urlFileId can still be undefined for a render or two. Fall back
      // to the ref (updated synchronously on select) so entering fullscreen
      // right after opening a file doesn't drop the id from the URL.
      const fileId = urlFileId ?? selectedFileRef.current?.id;
      if (next) {
        fullscreenEntryPushedRef.current = true;
        void navigate({
          to: '/app/gallery',
          search: { fileId, fs: true }
        });
        return;
      }
      if (fullscreenEntryPushedRef.current) {
        fullscreenEntryPushedRef.current = false;
        router.history.back();
        return;
      }
      void navigate({
        to: '/app/gallery',
        replace: true,
        search: { fileId, fs: undefined }
      });
    },
    [navigate, router, urlFileId]
  );

  const fileDetailCtl = useFileDetailController({
    gallery: {
      files: galleryCtl.galleryFiles,
      currentIndex,
      goRelative: (delta) => void goRelativeWrapper(delta)
    },
    sauceSettings: sauceFavoritesCtl.sauceSettings,
    mediaFullscreen: fullscreen,
    onFullscreenChange: setFullscreen,
    onClose: closeGalleryDetailUrl,
    onFileDeleted: galleryCtl.removeFileFromGallery,
    onFileRestored: galleryCtl.restoreFileToGallery
  });

  selectedFileRef.current = fileDetailCtl.selectedFile;
  fileDetailCtlRef.current = fileDetailCtl;

  // The URL follows from the sync effect below, which is the only place that
  // writes it. Doing it here too raced the effect and could replace the
  // gallery's own history entry with the file's.
  const openGalleryFile = useCallback(
    (file: FileItem) => {
      fileDetailCtl.rememberGalleryScroll();
      fileDetailCtl.openFile(file);
    },
    [fileDetailCtl]
  );

  // prev/next moves between files with the detail already open, so it opens
  // without recording a position — the window sits at the top of the detail
  // view by then, and the gallery's own position is already saved.
  openFileRef.current = fileDetailCtl.openFile;

  // Single pass that reconciles URL and selection. See galleryDetailSync.ts
  // for why this must be one effect deciding one action.
  // Starts unset even on a deep link: the first pass must read as "the URL
  // just gained a file" so it opens it, rather than as a steady URL with no
  // selection, which would clear the deep link on load.
  const previousUrlFileIdRef = useRef<string | undefined>(undefined);
  const previousFullscreenRef = useRef(false);
  const { closeFile, openFile } = fileDetailCtl;
  const { galleryFiles } = galleryCtl;

  useEffect(() => {
    if (!onGalleryRoute) return;
    const exitedFullscreen = previousFullscreenRef.current && !fullscreen;
    const action = getDetailUrlSyncAction({
      urlFileId,
      previousUrlFileId: previousUrlFileIdRef.current,
      selectedFileId: fileDetailCtl.selectedFile?.id,
      exitedFullscreen
    });

    if (action.type === 'open') {
      const match = galleryFiles.find((file) => file.id === action.fileId);
      // The gallery may not have loaded this page yet; leave the ref untouched
      // so the next galleryFiles update retries instead of dropping the file.
      if (!match) return;
      openFile(match);
    } else if (action.type === 'close') {
      detailEntryPushedRef.current = false;
      closeFile({ syncUrl: false });
    } else if (action.type === 'mirror-url') {
      if (action.mode === 'push') detailEntryPushedRef.current = true;
      void navigate({
        to: '/app/gallery',
        replace: action.mode === 'replace',
        // Swiping between files inside fullscreen must stay in fullscreen;
        // entering the detail view never starts in it.
        search: {
          fileId: action.fileId,
          fs: action.mode === 'replace' && fullscreen ? true : undefined
        }
      });
    } else if (action.type === 'clear-url') {
      detailEntryPushedRef.current = false;
      void navigate({
        to: '/app/gallery',
        replace: true,
        search: { fileId: undefined, fs: undefined }
      });
    }

    previousUrlFileIdRef.current = urlFileId;
    previousFullscreenRef.current = fullscreen;
  }, [
    closeFile,
    fullscreen,
    fileDetailCtl.selectedFile,
    galleryFiles,
    navigate,
    onGalleryRoute,
    openFile,
    urlFileId
  ]);

  const selectedVoteScore = fileDetailCtl.selectedFile?.voteScore;
  const selectedNextVoteAt = fileDetailCtl.selectedFile?.nextVoteAt;
  const voteFileId = fileDetailCtl.selectedFile?.id;
  const updateGalleryVote = galleryCtl.updateVote;

  // Mirror the panel's vote onto the gallery list. Driving this off the
  // rendered value covers the optimistic patch, an undo, and the server's
  // final answer through one path instead of three callbacks.
  useEffect(() => {
    if (!voteFileId || selectedVoteScore === undefined) return;
    updateGalleryVote(voteFileId, {
      voteScore: selectedVoteScore,
      nextVoteAt: selectedNextVoteAt ?? null
    });
  }, [voteFileId, selectedNextVoteAt, selectedVoteScore, updateGalleryVote]);

  const duplicatesViewProps = useMemo(
    () => ({
      ...duplicatesCtl.viewProps,
      resolveDuplicateChoice: (keep: DuplicateFile, discard: DuplicateFile) => {
        duplicatesCtl.viewProps.resolveDuplicateChoice(keep, discard);
        galleryCtl.removeFileFromGallery(discard.id);
        if (selectedFileRef.current?.id === discard.id) {
          fileDetailCtl.closeFile();
        }
      }
    }),
    [duplicatesCtl.viewProps, fileDetailCtl, galleryCtl]
  );

  useEffect(() => {
    const handle = () => {
      queryClient.setQueryData(queryKeys.auth.me(), null);
      queryClient.removeQueries({ queryKey: queryKeys.folders.all });
      queryClient.removeQueries({ queryKey: queryKeys.files.all });
      queryClient.removeQueries({ queryKey: queryKeys.sauces.all });
      queryClient.removeQueries({ queryKey: queryKeys.favorites.all });
      queryClient.removeQueries({ queryKey: queryKeys.credentials.all });
      queryClient.removeQueries({ queryKey: queryKeys.duplicates.all });
      queryClient.removeQueries({ queryKey: queryKeys.booruSites.all });
    };
    window.addEventListener(authRequiredEvent, handle);
    return () => window.removeEventListener(authRequiredEvent, handle);
  }, [queryClient]);

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (err) {
      // useLogout already clears local auth/query state on success.
      // Keep the visible warning so network failures do not disappear.

      console.warn('logout request failed', err);
    } finally {
      resetGalleryUiState();
      resetDuplicatesUiState();
      resetSettingsUiState();
      fileDetailCtl.closeFile({ syncUrl: false });
      galleryCtl.resetGallery();
      void navigate({
        to: '/login',
        replace: true,
        search: { redirect: undefined }
      });
    }
  }, [
    fileDetailCtl,
    galleryCtl,
    logoutMutation,
    navigate,
    resetDuplicatesUiState,
    resetGalleryUiState,
    resetSettingsUiState
  ]);

  const value = useMemo<AppShellContextValue>(
    () => ({
      authUser,
      logoutPending: logoutMutation.isPending,
      logoutError: (logoutMutation.error as Error | null)?.message ?? null,
      logout,
      foldersCtl,
      sauceFavoritesCtl,
      duplicatesCtl: {
        ...duplicatesCtl,
        viewProps: duplicatesViewProps
      },
      galleryCtl,
      fileDetailCtl,
      openGalleryFile
    }),
    [
      authUser,
      duplicatesCtl,
      duplicatesViewProps,
      fileDetailCtl,
      foldersCtl,
      galleryCtl,
      logout,
      logoutMutation.error,
      logoutMutation.isPending,
      openGalleryFile,
      sauceFavoritesCtl
    ]
  );

  return (
    <AppShellContext.Provider value={value}>
      <div className="bg-background text-foreground min-h-screen">
        <div className="container page-shell">
          <div className="page-chrome">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div
                className="btn-group hidden md:inline-flex"
                role="group"
                aria-label="view switcher"
              >
                <Link
                  to="/app/explore"
                  search={{ post: undefined }}
                  className="btn btn-outline-light"
                  activeProps={{ className: 'btn btn-primary' }}
                >
                  Explore
                </Link>
                <Link
                  to="/app/gallery"
                  search={{ fileId: undefined, fs: undefined }}
                  className="btn btn-outline-light"
                  activeProps={{ className: 'btn btn-primary' }}
                >
                  Gallery
                </Link>
                {gamesTabEnabled ? (
                  <Link
                    to="/app/games"
                    className="btn btn-outline-light"
                    activeProps={{ className: 'btn btn-primary' }}
                  >
                    Games
                  </Link>
                ) : null}
                <Link
                  to="/app/settings"
                  className="btn btn-outline-light"
                  activeProps={{ className: 'btn btn-primary' }}
                >
                  Settings
                </Link>
              </div>

              {/* Explore publishes the open post's navigation to a store,
                  so the same header controls serve both pages. */}
              {!fileDetailCtl.selectedFile && exploreNav ? (
                <div className="hidden md:flex items-center gap-3">
                  <button
                    className="file-detail-back-btn"
                    onClick={exploreNav.close}
                  >
                    <svg
                      className="file-detail-back-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                    Back to explore
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      className="btn btn-outline-secondary btn-sm"
                      onClick={() => exploreNav.goRelative(-1)}
                      disabled={!exploreNav.hasPrev}
                      aria-label="Previous"
                    >
                      ‹ Prev
                    </button>
                    <button
                      className="btn btn-outline-secondary btn-sm"
                      onClick={() => exploreNav.goRelative(1)}
                      disabled={!exploreNav.hasNext}
                      aria-label="Next"
                    >
                      Next ›
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Desktop-only: on mobile the file detail view relies on
                  swipe/tap-outside/the tab bar instead of explicit buttons. */}
              {fileDetailCtl.selectedFile ? (
                <div className="hidden md:flex items-center gap-3">
                  <button
                    className="file-detail-back-btn"
                    onClick={() => fileDetailCtl.closeFile()}
                  >
                    <svg
                      className="file-detail-back-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                    Back to gallery
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      className="btn btn-outline-secondary btn-sm"
                      onClick={() => fileDetailCtl.panelProps.onGoRelative(-1)}
                      disabled={!fileDetailCtl.panelProps.hasPrev}
                      aria-label="Previous"
                    >
                      ‹ Prev
                    </button>
                    <button
                      className="btn btn-outline-secondary btn-sm"
                      onClick={() => fileDetailCtl.panelProps.onGoRelative(1)}
                      disabled={!fileDetailCtl.panelProps.hasNext}
                      aria-label="Next"
                    >
                      Next ›
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Below 768px the inline group above wraps past 4 items, so
                mobile gets a fixed capsule tab bar instead. */}
            <AppTabBar
              hidden={
                Boolean(fileDetailCtl.selectedFile) || Boolean(exploreNav)
              }
            />
          </div>
          <Outlet />
        </div>
      </div>
    </AppShellContext.Provider>
  );
}
