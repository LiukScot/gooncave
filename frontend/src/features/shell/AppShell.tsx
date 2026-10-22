import {
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
import { useGalleryExploreBridge } from './useGalleryExploreBridge';
import { GALLERY_SCROLL_KEY, rememberListPlace } from './windowScroll';

import { type DeviceProfile, type FileItem } from '@/api';
import { useDuplicatesController } from '@/features/duplicates/useDuplicatesController';
import { useSourceFavoritesController } from '@/features/favorites-source/useSourceFavoritesController';
import { useFileDetailController } from '@/features/file-detail/useFileDetailController';
import { useFileImport } from '@/features/folders/useFileImport';
import { useFoldersController } from '@/features/folders/useFoldersController';
import { useGalleryController } from '@/features/library/useGalleryController';
import { useDeviceProfile } from '@/hooks/device';
import { galleryTileImage, transitionView } from '@/lib/viewTransitions';
import { useExploreUiStore } from '@/stores/exploreUiStore';

type AppShellContextValue = {
  authUser: DeviceProfile;
  sourceFavoritesCtl: ReturnType<typeof useSourceFavoritesController>;
  duplicatesCtl: ReturnType<typeof useDuplicatesController>;
  galleryCtl: ReturnType<typeof useGalleryController>;
  fileDetailCtl: ReturnType<typeof useFileDetailController>;
  openGalleryFile: (file: FileItem) => void;
  /** Adds files the person picked to the library; `undefined` when there is no library to add to. */
  addFiles: ((files: File[]) => void) | undefined;
  /** Opens the iPhone photo picker; `undefined` when there is no library to add to. */
  addFromPhotos: (() => void) | undefined;
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
  const profile = useDeviceProfile();
  if (profile.isPending) return <div className="container page-shell" role="status">Opening your library…</div>;
  if (profile.isError) return (
    <div className="container page-shell">
      <h1 className="page-title">Library unavailable</h1>
      <p role="alert">{profile.error.message} Check free disk space and folder permissions.</p>
      <button className="btn btn-primary" type="button" onClick={() => void profile.refetch()}>Open library again</button>
    </div>
  );
  return <DeviceAppShell authUser={profile.data} />;
}

function DeviceAppShell({ authUser }: { authUser: DeviceProfile }) {
  const navigate = useNavigate();
  const exploreNav = useExploreUiStore((state) => state.detailNav);
  const setGalleryBridge = useExploreUiStore(
    (state) => state.setGalleryBridge
  );

  const selectedFileRef = useRef<FileItem | null>(null);
  const openFileRef = useRef<(file: FileItem) => void>(() => undefined);
  const galleryCtlRef = useRef<ReturnType<typeof useGalleryController> | null>(
    null
  );

  const libraryRoot = authUser.libraryRoot ?? '';

  const sourceFavoritesCtl = useSourceFavoritesController({
    authUser
  });

  const foldersCtl = useFoldersController({
    authUser,
    libraryRoot,
    onScanFinished: () => void galleryCtlRef.current?.reloadGallery({ preserveOrder: true })
  });


  const duplicatesCtl = useDuplicatesController({
    authUser
  });

  const galleryCtl = useGalleryController({ authUser });
  galleryCtlRef.current = galleryCtl;

  const rootFolderId =
    authUser.capabilities?.library === false
      ? null
      : foldersCtl.rootFolderId;
  const { dragging: draggingFiles, addFiles, addFromPhotos } = useFileImport(rootFolderId, () =>
    void galleryCtlRef.current?.reloadGallery({ preserveOrder: true })
  );

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

  useGalleryExploreBridge({
    galleryControllerRef: galleryCtlRef,
    selectedFileRef,
    openFileRef,
    navigate,
    setGalleryBridge
  });
  const currentIndex = selectedFileRef.current
    ? galleryCtl.selectedFileIndex(selectedFileRef.current.id)
    : -1;

  // --- detail view URL state ------------------------------------------------
  // The gallery route owns `fileId` and `fs`, but the detail controller lives
  // here, so read the search
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
    sourceSettings: sourceFavoritesCtl.sourceSettings,
    mediaFullscreen: fullscreen,
    onFullscreenChange: setFullscreen,
    onClose: closeGalleryDetailUrl,
    onFileDeleted: galleryCtl.removeFileFromGallery,
    onFileRestored: galleryCtl.restoreFileToGallery
  });

  selectedFileRef.current = fileDetailCtl.selectedFile;

  // The URL follows from the sync effect below, which is the only place that
  // writes it. Doing it here too raced the effect and could replace the
  // gallery's own history entry with the file's.
  const openGalleryFile = useCallback(
    (file: FileItem) => {
      rememberListPlace(GALLERY_SCROLL_KEY);
      transitionView(
        'detail-open',
        () => fileDetailCtl.openFile(file),
        galleryTileImage(file.id)
      );
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
  const selectedLocation = fileDetailCtl.selectedFile?.locationType;
  const updateGalleryFile = galleryCtl.updateFile;

  // Mirror the panel's vote onto the gallery list. Driving this off the
  // rendered value covers the optimistic patch, an undo, and the server's
  // final answer through one path instead of three callbacks.
  useEffect(() => {
    if (!voteFileId || selectedVoteScore === undefined) return;
    updateGalleryFile(voteFileId, {
      voteScore: selectedVoteScore,
      nextVoteAt: selectedNextVoteAt ?? null
    });
  }, [voteFileId, selectedNextVoteAt, selectedVoteScore, updateGalleryFile]);

  // Keeping a file from the panel downloads it, so its tile loses the cloud mark.
  useEffect(() => {
    if (!voteFileId || !selectedLocation) return;
    updateGalleryFile(voteFileId, { locationType: selectedLocation });
  }, [voteFileId, selectedLocation, updateGalleryFile]);

  const duplicatesViewProps = duplicatesCtl.viewProps;

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  }, []);

  const value = useMemo<AppShellContextValue>(
    () => ({
      authUser,
      sourceFavoritesCtl,
      duplicatesCtl: {
        ...duplicatesCtl,
        viewProps: duplicatesViewProps
      },
      galleryCtl,
      fileDetailCtl,
      openGalleryFile,
      addFiles: rootFolderId ? addFiles : undefined,
      addFromPhotos: rootFolderId ? addFromPhotos : undefined
    }),
    [
      authUser,
      duplicatesCtl,
      addFiles,
      addFromPhotos,
      duplicatesViewProps,
      fileDetailCtl,
      rootFolderId,
      galleryCtl,
      openGalleryFile,
      sourceFavoritesCtl
    ]
  );

  return (
    <AppShellContext.Provider value={value}>
      <div className="bg-page-background text-foreground min-h-screen">
        <div className="container page-shell">
          <div className="page-chrome">
            {/* Hidden while a file or post is open: its own back button
                on the picture is the way out. */}
            <AppTabBar
              hidden={
                Boolean(fileDetailCtl.selectedFile) || Boolean(exploreNav)
              }
            />
          </div>
          <Outlet />
        </div>
        {draggingFiles ? (
          <div className="file-drop-overlay" aria-hidden="true">
            <p>Drop to add to your library</p>
          </div>
        ) : null}
      </div>
    </AppShellContext.Provider>
  );
}
