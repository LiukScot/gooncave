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

import { getDetailUrlSyncAction } from './galleryDetailSync';

import { authRequiredEvent, type FileItem } from '@/api';
import { useDuplicatesController } from '@/features/duplicates/useDuplicatesController';
import { useSauceFavoritesController } from '@/features/favorites-sauce/useSauceFavoritesController';
import { useFileDetailController } from '@/features/file-detail/useFileDetailController';
import { useFoldersController } from '@/features/folders/useFoldersController';
import { useGalleryController } from '@/features/library/useGalleryController';
import { useCurrentUser, useLogout } from '@/hooks/auth';
import { queryKeys } from '@/lib/query-keys';
import { useDuplicatesUiStore } from '@/stores/duplicatesUiStore';
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
  closeGalleryFile: () => void;
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

  const duplicatesCtl = useDuplicatesController({
    authUser
  });

  const galleryCtl = useGalleryController({
    authUser,
    folders: foldersCtl.folders,
    orderedFolders: foldersCtl.orderedFolders,
    folderDetailsById: foldersCtl.folderDetailsById,
    isActive: true,
    onRefreshAfterOrderFailure: () => void foldersCtl.refreshFolders()
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
      if (next) {
        fullscreenEntryPushedRef.current = true;
        void navigate({
          to: '/app/gallery',
          search: { fileId: urlFileId, fs: true }
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
        search: { fileId: urlFileId, fs: undefined }
      });
    },
    [navigate, router, urlFileId]
  );

  const fileDetailCtl = useFileDetailController({
    gallery: {
      files: galleryCtl.galleryFiles,
      currentIndex,
      goRelative: (delta) => void goRelativeWrapper(delta),
      sortIsManual: galleryCtl.viewProps.gallerySort === 'manual'
    },
    sauceSettings: sauceFavoritesCtl.sauceSettings,
    mediaFullscreen: fullscreen,
    onFullscreenChange: setFullscreen,
    onClose: closeGalleryDetailUrl
  });

  selectedFileRef.current = fileDetailCtl.selectedFile;
  fileDetailCtlRef.current = fileDetailCtl;

  // The URL follows from the sync effect below, which is the only place that
  // writes it. Doing it here too raced the effect and could replace the
  // gallery's own history entry with the file's.
  const openGalleryFile = useCallback(
    (file: FileItem) => {
      fileDetailCtl.openFile(file);
    },
    [fileDetailCtl]
  );

  const closeGalleryFile = useCallback(() => {
    fileDetailCtl.closeFile();
  }, [fileDetailCtl]);

  openFileRef.current = openGalleryFile;

  // Single pass that reconciles URL and selection. See galleryDetailSync.ts
  // for why this must be one effect deciding one action.
  // Starts unset even on a deep link: the first pass must read as "the URL
  // just gained a file" so it opens it, rather than as a steady URL with no
  // selection, which would clear the deep link on load.
  const previousUrlFileIdRef = useRef<string | undefined>(undefined);
  const { closeFile, openFile } = fileDetailCtl;
  const { galleryFiles } = galleryCtl;

  useEffect(() => {
    if (!onGalleryRoute) return;
    const action = getDetailUrlSyncAction({
      urlFileId,
      previousUrlFileId: previousUrlFileIdRef.current,
      selectedFileId: fileDetailCtl.selectedFile?.id
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
        search: { fileId: action.fileId, fs: undefined }
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
  }, [
    closeFile,
    fileDetailCtl.selectedFile,
    galleryFiles,
    navigate,
    onGalleryRoute,
    openFile,
    urlFileId
  ]);

  const filePanelProps = useMemo(
    () => ({
      ...fileDetailCtl.panelProps,
      onToggleFavorite: () => {
        const current = selectedFileRef.current;
        fileDetailCtl.panelProps.onToggleFavorite();
        if (current) {
          galleryCtl.updateFavoriteFlag(current.id, !current.isFavorite);
        }
      },
      onDeleteFile: (id: string) => {
        fileDetailCtl.panelProps.onDeleteFile(id);
        galleryCtl.removeFileFromGallery(id);
      }
    }),
    [fileDetailCtl.panelProps, galleryCtl]
  );

  const duplicatesViewProps = useMemo(
    () => ({
      ...duplicatesCtl.viewProps,
      resolveDuplicateChoice: (keep: FileItem, discard: FileItem) => {
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
      void navigate({ to: '/login', replace: true });
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
      fileDetailCtl: {
        ...fileDetailCtl,
        panelProps: filePanelProps
      },
      openGalleryFile,
      closeGalleryFile
    }),
    [
      authUser,
      closeGalleryFile,
      duplicatesCtl,
      duplicatesViewProps,
      fileDetailCtl,
      filePanelProps,
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
            <div className="flex justify-between items-center mb-4">
              <div>
                <h1 className="h3 mb-1">GoonCave</h1>
                <div className="text-muted-foreground text-sm">
                  Signed in as {authUser.username}
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <button
                  className="btn btn-outline-light btn-sm"
                  type="button"
                  onClick={() => void logout()}
                  disabled={logoutMutation.isPending}
                >
                  {logoutMutation.isPending ? 'Logging out…' : 'Logout'}
                </button>
                {value.logoutError ? (
                  <div className="text-destructive text-sm">
                    {value.logoutError}
                  </div>
                ) : null}
              </div>
            </div>

            <div
              className="btn-group mb-4"
              role="group"
              aria-label="view switcher"
            >
              <Link
                to="/app/gallery"
                search={{ fileId: undefined, fs: undefined }}
                className="btn btn-outline-light"
                activeProps={{ className: 'btn btn-primary' }}
              >
                Gallery
              </Link>
              <Link
                to="/app/favorites"
                className="btn btn-outline-light"
                activeProps={{ className: 'btn btn-primary' }}
              >
                Favorites
              </Link>
              <Link
                to="/app/duplicates"
                className="btn btn-outline-light"
                activeProps={{ className: 'btn btn-primary' }}
              >
                Duplicates
              </Link>
              <Link
                to="/app/folders"
                className="btn btn-outline-light"
                activeProps={{ className: 'btn btn-primary' }}
              >
                Settings
              </Link>
            </div>

            {galleryCtl.manualOrderState.error ? (
              <div className="text-destructive mb-4">
                Manual order: {galleryCtl.manualOrderState.error}
              </div>
            ) : null}
            {galleryCtl.manualOrderState.loading ? (
              <div className="text-muted-foreground text-sm mb-4">
                Saving manual order…
              </div>
            ) : null}
          </div>
          <Outlet />
        </div>
      </div>
    </AppShellContext.Provider>
  );
}
