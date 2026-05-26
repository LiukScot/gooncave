import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { authRequiredEvent } from './api';
import type { FileItem } from './api';
import { AuthForm } from '@/features/auth/AuthForm';
import { FileDetailPanel } from '@/features/file-detail/FileDetailPanel';
import { FoldersListPanel } from '@/features/folders/FoldersListPanel';
import { SauceFavoritesSettings } from '@/features/favorites-sauce/SauceFavoritesSettings';
import { DuplicatesView } from '@/features/duplicates/DuplicatesView';
import { GalleryView } from '@/features/library/GalleryView';
import { useAuthController } from '@/features/auth/useAuthController';
import { useFoldersController } from '@/features/folders/useFoldersController';
import { useDuplicatesController } from '@/features/duplicates/useDuplicatesController';
import { useSauceFavoritesController } from '@/features/favorites-sauce/useSauceFavoritesController';
import { useGalleryController } from '@/features/library/useGalleryController';
import { useFileDetailController } from '@/features/file-detail/useFileDetailController';
import { queryKeys } from '@/lib/query-keys';

type ViewMode = 'folders' | 'gallery' | 'duplicates';

const uploadInputAccept =
  '.jpg,.jpeg,.png,.gif,.bmp,.webp,.tif,.tiff,.avif,.mp4,.mov,.avi,.mkv,.webm,.wmv,.flv,.m4v';

function App() {
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('gallery');

  // ---------------------------------------------------------------------------
  // Stable ref for the selected file — used to compute currentIndex for the
  // file-detail controller without a circular dependency in the same render.
  // Updated after every render via the useEffect below.
  // ---------------------------------------------------------------------------
  const selectedFileRef = useRef<FileItem | null>(null);

  // Stable ref so goRelativeWrapper can call the latest openFile without
  // re-creating itself on every render.
  const openFileRef = useRef<(file: FileItem) => void>(() => undefined);

  // Stable ref to galleryCtl — declared early so callbacks passed to earlier
  // controllers (auth, folders) can safely reference it.
  const galleryCtlRef = useRef<ReturnType<typeof useGalleryController> | null>(null);

  // ---------------------------------------------------------------------------
  // Auth controller
  // ---------------------------------------------------------------------------
  const auth = useAuthController({
    onLoginSuccess: () => {
      galleryCtlRef.current?.resetGallery();
    },
  });

  const libraryRoot = auth.authUser?.libraryRoot ?? '';

  // ---------------------------------------------------------------------------
  // Sauce + favorites controller — needed before folders (folders needs settings)
  // ---------------------------------------------------------------------------
  const sauceFavoritesCtl = useSauceFavoritesController({
    authUser: auth.authUser,
  });

  // ---------------------------------------------------------------------------
  // Folders controller
  // ---------------------------------------------------------------------------

  const foldersCtl = useFoldersController({
    authUser: auth.authUser,
    libraryRoot,
    favoritesSettings: sauceFavoritesCtl.settingsProps.favoritesSettings,
    favoritesSettingsState: sauceFavoritesCtl.settingsProps.favoritesSettingsState,
    onUpdateFavoritesRoot: (folderId) =>
      void sauceFavoritesCtl.settingsProps.updateFavoritesSettings({ favoritesRootId: folderId }),
    uploadInputAccept,
    onUploadComplete: () => void galleryCtlRef.current?.reloadGallery(),
    onScanFinished: () => {
      if (viewMode === 'gallery') {
        void galleryCtlRef.current?.reloadGallery();
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Duplicates controller
  // ---------------------------------------------------------------------------
  const duplicatesCtl = useDuplicatesController({
    authUser: auth.authUser,
  });

  // ---------------------------------------------------------------------------
  // Gallery controller
  // ---------------------------------------------------------------------------
  const galleryCtl = useGalleryController({
    authUser: auth.authUser,
    folders: foldersCtl.folders,
    orderedFolders: foldersCtl.orderedFolders,
    folderDetailsById: foldersCtl.folderDetailsById,
    isActive: viewMode === 'gallery',
    onRefreshAfterOrderFailure: () => void foldersCtl.refreshFolders(),
  });

  // Keep galleryCtlRef in sync on every render.
  galleryCtlRef.current = galleryCtl;

  // ---------------------------------------------------------------------------
  // goRelative wrapper: navigate to file at delta distance from the current
  // selected file. Passed to fileDetailCtl as gallery.goRelative.
  // ---------------------------------------------------------------------------
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
        // Load next page; the new files will be in galleryCtl.galleryFiles on
        // the next render. We can't read them synchronously here (state update
        // is async), so we rely on the file-detail controller's own "hasNext"
        // guard — the user presses arrow-right again after the page loads.
        await galleryCtl.goRelative(current.id, delta);
      }
    },
    // Stable useCallback — dependencies are all controller-level refs/fns
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [galleryCtl.selectedFileIndex, galleryCtl.galleryFiles, galleryCtl.galleryHasMore, galleryCtl.goRelative],
  );

  // ---------------------------------------------------------------------------
  // File detail controller
  // currentIndex is computed from selectedFileRef so we avoid a circular dep.
  // On first render selectedFileRef.current is null → currentIndex = -1, which
  // is the correct "no file selected" sentinel.
  // ---------------------------------------------------------------------------
  const selectedFileId = selectedFileRef.current?.id;
  const currentIndex =
    selectedFileId != null ? galleryCtl.selectedFileIndex(selectedFileId) : -1;

  const fileDetailCtl = useFileDetailController({
    gallery: {
      files: galleryCtl.galleryFiles,
      currentIndex,
      goRelative: (delta) => void goRelativeWrapper(delta),
      sortIsManual: galleryCtl.viewProps.gallerySort === 'manual',
    },
    sauceSettings: sauceFavoritesCtl.sauceSettings,
  });

  // Keep refs in sync after every render so callbacks see the current values.
  selectedFileRef.current = fileDetailCtl.selectedFile;
  openFileRef.current = (file: FileItem) => {
    galleryCtl.openFile(file);       // saves scroll position
    fileDetailCtl.openFile(file);    // sets selectedFile state + history push
  };

  // ---------------------------------------------------------------------------
  // Cross-feature: gallery onFileOpen calls the combined openFile
  // ---------------------------------------------------------------------------
  const galleryViewProps = {
    ...galleryCtl.viewProps,
    onFileOpen: (file: FileItem) => openFileRef.current(file),
  };

  // ---------------------------------------------------------------------------
  // auth-required event handler — kept in App (per controller comments)
  // ---------------------------------------------------------------------------
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

  // Disable browser scroll-restoration so our manual restore works correctly.
  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (auth.authLoading && !auth.authUser) {
    return (
      <div className="bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Checking session…</div>
      </div>
    );
  }

  if (!auth.authUser) {
    return <AuthForm {...auth.formProps} />;
  }

  return (
    <div className="bg-background text-foreground min-h-screen">
      {fileDetailCtl.selectedFile ? null : (
        <div className="container page-shell">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h1 className="h3 mb-1">GoonCave</h1>
              <div className="text-muted-foreground text-sm">
                Signed in as {auth.authUser.username}
              </div>
            </div>
            <div>
              <button
                className="btn btn-outline-light btn-sm"
                type="button"
                onClick={() => void auth.logout()}
              >
                Logout
              </button>
            </div>
          </div>

          <div className="btn-group mb-6" role="group" aria-label="view switcher">
            <button
              className={`btn btn-${viewMode === 'gallery' ? 'primary' : 'outline-light'}`}
              onClick={() => setViewMode('gallery')}
            >
              Gallery
            </button>
            <button
              className={`btn btn-${viewMode === 'duplicates' ? 'primary' : 'outline-light'}`}
              onClick={() => setViewMode('duplicates')}
            >
              Duplicates
            </button>
            <button
              className={`btn btn-${viewMode === 'folders' ? 'primary' : 'outline-light'}`}
              onClick={() => setViewMode('folders')}
            >
              Settings
            </button>
          </div>

          <div className={`row ${viewMode === 'folders' ? 'g-0 settings-sections' : 'g-4'}`}>
            {viewMode === 'folders' ? (
              <>
                <FoldersListPanel {...foldersCtl.panelProps} />
                <SauceFavoritesSettings {...sauceFavoritesCtl.settingsProps} />
              </>
            ) : viewMode === 'duplicates' ? (
              <DuplicatesView {...duplicatesCtl.viewProps} />
            ) : (
              <GalleryView {...galleryViewProps} />
            )}
          </div>
        </div>
      )}

      {fileDetailCtl.selectedFile ? (
        <FileDetailPanel {...fileDetailCtl.panelProps} />
      ) : null}
    </div>
  );
}

export default App;
