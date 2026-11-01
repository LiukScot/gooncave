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
import { toast } from 'sonner';

import { AppMenu } from './AppMenu';
import { getDetailUrlSyncAction } from './galleryDetailSync';
import { LibraryRepairNotice } from './LibraryRepairNotice';
import { useDetailAnchor } from './useDetailAnchor';
import { useGalleryExploreBridge } from './useGalleryExploreBridge';
import { useGalleryFollowsSync } from './useGalleryFollowsSync';
import { GALLERY_SCROLL_KEY, rememberListPlace } from './windowScroll';

import { api, type DeviceProfile, type FileItem } from '@/api';
import { useDuplicatesController } from '@/features/duplicates/useDuplicatesController';
import { useSourceFavoritesController } from '@/features/favorites-source/useSourceFavoritesController';
import { useFileDetailController } from '@/features/file-detail/useFileDetailController';
import { useFileImport } from '@/features/folders/useFileImport';
import { useFoldersController } from '@/features/folders/useFoldersController';
import { useGalleryController } from '@/features/library/useGalleryController';
import { useDeviceProfile } from '@/hooks/device';
import { useEdgeSwipeBack } from '@/lib/edgeSwipeBack';
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
  const { anchorRef: anchorFileIdRef, track: trackAnchor, markAside } =
    useDetailAnchor();
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
    void galleryCtlRef.current?.showNewest()
  );

  const goRelativeWrapper = useCallback(
    async (delta: number) => {
      const currentId = anchorFileIdRef.current;
      if (!currentId) return;
      const idx = galleryCtl.selectedFileIndex(currentId);
      if (idx === -1) return;
      const nextFile = galleryCtl.galleryFiles[idx + delta];
      if (nextFile) {
        openFileRef.current(nextFile);
        return;
      }
      if (delta > 0 && galleryCtl.galleryHasMore) {
        await galleryCtl.goRelative(currentId, delta);
        const freshId = anchorFileIdRef.current;
        if (!freshId) return;
        const freshIndex = galleryCtl.selectedFileIndex(freshId);
        if (freshIndex === -1) return;
        const loadedNeighbor = galleryCtl.galleryFiles[freshIndex + delta];
        if (loadedNeighbor) {
          openFileRef.current(loadedNeighbor);
        }
      }
    },
    [anchorFileIdRef, galleryCtl]
  );

  useGalleryExploreBridge({
    galleryControllerRef: galleryCtlRef,
    anchorIdRef: anchorFileIdRef,
    openFileRef,
    navigate,
    setGalleryBridge
  });
  const currentIndex = anchorFileIdRef.current
    ? galleryCtl.selectedFileIndex(anchorFileIdRef.current)
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

  useGalleryFollowsSync(
    sourceFavoritesCtl.favoritesAccountsProps.favoritesSyncStatus,
    pathname === '/app/gallery' && !urlFileId,
    () => void galleryCtlRef.current?.refreshNewest(),
    (keepPlace) => void galleryCtlRef.current?.reloadGallery({ preserveOrder: keepPlace })
  );
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
    if (urlFileId) return;
    detailEntryPushedRef.current = false;
    useExploreUiStore.setState({ fileOpensFromHistory: false });
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
  const selectedId = fileDetailCtl.selectedFile?.id ?? null;
  trackAnchor(selectedId);

  const setOpenLibraryAside = useExploreUiStore(
    (state) => state.setOpenLibraryAside
  );
  const { openFile: openDetailFile } = fileDetailCtl;
  useEffect(() => {
    if (!onGalleryRoute || !selectedId) {
      setOpenLibraryAside(null);
      return;
    }
    setOpenLibraryAside(async (fileId) => {
      const file =
        galleryCtl.galleryFiles.find((item) => item.id === fileId) ??
        (await api.getFile(fileId));
      if (!file) return false;
      markAside(file.id);
      openDetailFile(file);
      return true;
    });
    return () => setOpenLibraryAside(null);
  }, [galleryCtl.galleryFiles, markAside, onGalleryRoute, openDetailFile, selectedId, setOpenLibraryAside]);

  useEdgeSwipeBack(
    () => Boolean(selectedFileRef.current) && detailEntryPushedRef.current && !fullscreen,
    // Going forward again reopens the file from the URL, which is not a push.
    () => {
      detailEntryPushedRef.current = true;
    }
  );

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

  const fileLookupRef = useRef<string | null>(null);
  const latestUrlFileIdRef = useRef(urlFileId);
  latestUrlFileIdRef.current = urlFileId;
  // Before the sync effect below: coming back to a file whose lookup failed asks again.
  useEffect(() => {
    if (fileLookupRef.current !== urlFileId) fileLookupRef.current = null;
  }, [urlFileId]);
  const lookUpFile = useCallback(
    (fileId: string) => {
      if (fileLookupRef.current === fileId) return;
      fileLookupRef.current = fileId;
      api.getFile(fileId).then(
        (file) => {
          if (fileLookupRef.current === fileId) fileLookupRef.current = null;
          // The person moved on, or the gallery's next page brought the file first.
          if (latestUrlFileIdRef.current !== fileId || selectedFileRef.current?.id === fileId) return;
          if (file) {
            openFile(file);
            return;
          }
          toast.error('This file is no longer in your library');
          void navigate({
            to: '/app/gallery',
            replace: true,
            search: { fileId: undefined, fs: undefined }
          });
        },
        (error: Error) => {
          if (latestUrlFileIdRef.current !== fileId) return;
          // fileLookupRef stays set, so the gallery's own updates do not ask again in a loop.
          toast.error(`Could not open this file: ${error.message}`, {
            action: {
              label: 'Open the file again',
              onClick: () => {
                fileLookupRef.current = null;
                lookUpFile(fileId);
              }
            }
          });
        }
      );
    },
    [navigate, openFile]
  );

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
      if (useExploreUiStore.getState().fileOpensFromHistory) detailEntryPushedRef.current = true;
      const match = galleryFiles.find((file) => file.id === action.fileId);
      // Not in the pages loaded so far, and it may never be: ask for it by id.
      // Leaving the ref untouched keeps this pass's answer 'open' until it arrives.
      if (!match) {
        lookUpFile(action.fileId);
        return;
      }
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
    lookUpFile,
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
      <div className="app-frame bg-page-background text-foreground min-h-screen">
        <LibraryRepairNotice
          hidden={Boolean(fileDetailCtl.selectedFile) || Boolean(exploreNav)}
        />
        {/* Hidden while a file or post is open: its own back button on the
            picture is the way out. */}
        <AppMenu
          detailOpen={Boolean(fileDetailCtl.selectedFile) || Boolean(exploreNav)}
        />
        <div className="search-lens-slot" />
        <div className="container page-shell">
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
