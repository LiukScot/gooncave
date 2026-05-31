import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useSearch } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef
} from 'react';

import {
  getGalleryDetailSyncAction,
  shouldApplyFileIdToSelection
} from './galleryDetailSync';

import { authRequiredEvent, type FileItem } from '@/api';
import { DuplicatesView } from '@/features/duplicates/DuplicatesView';
import { useDuplicatesController } from '@/features/duplicates/useDuplicatesController';
import { FavoritesAccountsSettings } from '@/features/favorites-accounts/FavoritesAccountsSettings';
import { SauceFavoritesSettings } from '@/features/favorites-sauce/SauceFavoritesSettings';
import { useSauceFavoritesController } from '@/features/favorites-sauce/useSauceFavoritesController';
import { FileDetailPanel } from '@/features/file-detail/FileDetailPanel';
import { useFileDetailController } from '@/features/file-detail/useFileDetailController';
import { FoldersListPanel } from '@/features/folders/FoldersListPanel';
import { useFoldersController } from '@/features/folders/useFoldersController';
import { GalleryView } from '@/features/library/GalleryView';
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

function useAppShellContext() {
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
  const clearGalleryDetailUrl = useCallback(() => {
    void navigate({
      to: '/app/gallery',
      replace: true,
      search: {}
    });
  }, [navigate]);

  const fileDetailCtl = useFileDetailController({
    gallery: {
      files: galleryCtl.galleryFiles,
      currentIndex,
      goRelative: (delta) => void goRelativeWrapper(delta),
      sortIsManual: galleryCtl.viewProps.gallerySort === 'manual'
    },
    sauceSettings: sauceFavoritesCtl.sauceSettings,
    historyMode: 'external',
    onExternalClose: clearGalleryDetailUrl
  });

  selectedFileRef.current = fileDetailCtl.selectedFile;
  fileDetailCtlRef.current = fileDetailCtl;

  const openGalleryFile = useCallback(
    (file: FileItem) => {
      galleryCtl.openFile();
      fileDetailCtl.openFile(file);
    },
    [fileDetailCtl, galleryCtl]
  );

  const closeGalleryFile = useCallback(() => {
    fileDetailCtl.closeFile();
  }, [fileDetailCtl]);

  openFileRef.current = openGalleryFile;

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
                search={{}}
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

export function GalleryRouteView() {
  const { galleryCtl, fileDetailCtl, openGalleryFile } = useAppShellContext();
  const navigate = useNavigate({ from: '/app/gallery' });
  const { fileId } = useSearch({ from: '/app/gallery' });
  const previousFileIdRef = useRef<string | undefined>(fileId);
  const selectedFileId = fileDetailCtl.selectedFile?.id;
  const previousSelectedFileIdRef = useRef<string | undefined>(selectedFileId);
  const clearGalleryDetailUrl = useCallback(() => {
    void navigate({
      replace: true,
      search: {}
    });
  }, [navigate]);

  useEffect(() => {
    if (!fileId) {
      if (previousFileIdRef.current && fileDetailCtl.selectedFile) {
        fileDetailCtl.closeFile();
      }
      previousFileIdRef.current = fileId;
      return;
    }
    if (
      !shouldApplyFileIdToSelection({
        fileId,
        selectedFileId,
        previousFileId: previousFileIdRef.current,
        previousSelectedFileId: previousSelectedFileIdRef.current
      })
    ) {
      previousFileIdRef.current = fileId;
      return;
    }
    const match = galleryCtl.galleryFiles.find((file) => file.id === fileId);
    if (match) {
      openGalleryFile(match);
    }
    previousFileIdRef.current = fileId;
  }, [
    fileId,
    selectedFileId,
    fileDetailCtl,
    galleryCtl.galleryFiles,
    openGalleryFile
  ]);

  useEffect(
    () => () => {
      fileDetailCtl.closeFile({ syncUrl: false });
    },
    [fileDetailCtl]
  );

  useEffect(() => {
    const action = getGalleryDetailSyncAction({
      fileId,
      selectedFileId,
      hadSelectedFile: Boolean(previousSelectedFileIdRef.current)
    });
    if (action.type === 'set') {
      void navigate({
        replace: true,
        search: (prev) => ({ ...prev, fileId: action.fileId })
      });
      return;
    }
    if (action.type === 'clear') {
      clearGalleryDetailUrl();
    }
  }, [clearGalleryDetailUrl, fileId, navigate, selectedFileId, fileDetailCtl]);

  useEffect(() => {
    if (!fileId) {
      previousSelectedFileIdRef.current = undefined;
      return;
    }
    if (selectedFileId !== undefined) {
      previousSelectedFileIdRef.current = selectedFileId;
    }
  }, [fileId, selectedFileId, fileDetailCtl]);

  return (
    <>
      {fileDetailCtl.selectedFile ? null : (
        <div className="row g-4">
          <GalleryView
            {...galleryCtl.viewProps}
            onFileOpen={(file) => {
              openGalleryFile(file);
              void navigate({
                search: (prev) => ({ ...prev, fileId: file.id })
              });
            }}
          />
        </div>
      )}

      {fileDetailCtl.selectedFile ? (
        <FileDetailPanel
          {...fileDetailCtl.panelProps}
          onClose={() => {
            fileDetailCtl.closeFile({ syncUrl: false });
            clearGalleryDetailUrl();
          }}
        />
      ) : null}
    </>
  );
}

export function FoldersRouteView() {
  const { foldersCtl, sauceFavoritesCtl } = useAppShellContext();

  return (
    <div className="page-chrome">
      <div className="row g-0 settings-sections">
        <FoldersListPanel {...foldersCtl.panelProps} />
        <SauceFavoritesSettings {...sauceFavoritesCtl.sauceSettingsProps} />
      </div>
    </div>
  );
}

export function FavoritesRouteView() {
  const { sauceFavoritesCtl } = useAppShellContext();
  return (
    <FavoritesAccountsSettings {...sauceFavoritesCtl.favoritesAccountsProps} />
  );
}

export function DuplicatesRouteView() {
  const { duplicatesCtl } = useAppShellContext();
  return (
    <div className="row g-4">
      <DuplicatesView {...duplicatesCtl.viewProps} />
    </div>
  );
}
