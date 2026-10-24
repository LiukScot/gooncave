import { Outlet, useRouter } from '@tanstack/react-router';
import { Images } from 'lucide-react';
import { useEffect } from 'react';

import { useAppShellContext } from './AppShell';
import { FeatureUnavailable } from './FeatureUnavailable';
import { GALLERY_SCROLL_KEY, useWindowScrollScreen } from './windowScroll';

import { DuplicatesView } from '@/features/duplicates/DuplicatesView';
import { FavoriteLinksCheck } from '@/features/duplicates/FavoriteLinksCheck';
import { ExploreView } from '@/features/explore/ExploreView';
import { FavoritesAccountsSettings } from '@/features/favorites-accounts/FavoritesAccountsSettings';
import { SourceFavoritesSettings } from '@/features/favorites-source/SourceFavoritesSettings';
import { FileDetailPanel } from '@/features/file-detail/FileDetailPanel';
import { GamesView } from '@/features/games/GamesView';
import { GalleryView } from '@/features/library/GalleryView';
import { PoolView } from '@/features/pools/PoolView';
import { AppearanceSettings } from '@/features/settings/AppearanceSettings';
import { BlacklistSettings } from '@/features/settings/BlacklistSettings';
import { ExtraSettings } from '@/features/settings/ExtraSettings';
import { SettingsLoadGate } from '@/features/settings/SettingsLoadGate';
import { SettingsMenu } from '@/features/settings/SettingsMenu';
import { SettingsSubpage } from '@/features/settings/SettingsSubpage';
import { ShortcutSettings } from '@/features/settings/ShortcutSettings';
import { SubscriptionsSettings } from '@/features/settings/SubscriptionsSettings';
import { SyncSettings } from '@/features/settings/SyncSettings';
import { TrashSettings } from '@/features/settings/TrashSettings';
import { useExtraSettings } from '@/hooks/settings';
import { useEdgeSwipeBack } from '@/lib/edgeSwipeBack';
import { isIos } from '@/lib/platform';

export function GalleryRouteView() {
  const { authUser, galleryCtl, fileDetailCtl, openGalleryFile, sourceFavoritesCtl, addFiles, addFromPhotos } = useAppShellContext();
  const { deleteAddedPhotos } = useExtraSettings();
  const { closeFile } = fileDetailCtl;
  const favorites = sourceFavoritesCtl.favoritesAccountsProps;
  const favoritesSync =
    authUser.capabilities?.boorus !== false && authUser.capabilities?.favorites !== false
      ? {
          running:
            favorites.favoritesSyncState.loading ||
            favorites.favoritesSyncStatus?.status === 'running',
          error: favorites.favoritesSyncState.error,
          onSync: () => void favorites.runFavoritesSync(false)
        }
      : undefined;
  const openFileId = fileDetailCtl.selectedFile?.id;
  useWindowScrollScreen(
    openFileId
      ? { kind: 'detail', key: openFileId }
      : { kind: 'list', key: GALLERY_SCROLL_KEY }
  );

  // Leaving the gallery route drops the selection; the URL it came from is
  // already gone, so do not try to rewrite it.
  useEffect(
    () => () => {
      closeFile({ syncUrl: false });
    },
    [closeFile]
  );

  // The grid stays mounted under an open file, so closing it shows the decoded
  // tiles again instead of building every card from scratch.
  return (
    <>
      <div hidden={Boolean(fileDetailCtl.selectedFile)}>
        <div className="page-chrome">
          <h1 className="uppercase font-semibold file-detail-section-title page-title mb-4">
            <Images className="page-title-icon" aria-hidden="true" />
            Gallery
          </h1>
          <div className="row g-4">
            <GalleryView
              {...galleryCtl.viewProps}
              libraryAvailable={authUser.capabilities?.library !== false}
              favoritesSync={favoritesSync}
              openFolderRoot={authUser.capabilities?.openFolder ? authUser.libraryRoot : undefined}
              onAddFiles={isIos() ? addFiles : undefined}
              onAddFromPhotos={authUser.capabilities?.photoLibrary && deleteAddedPhotos ? addFromPhotos : undefined}
              onFileOpen={openGalleryFile}
            />
          </div>
        </div>
      </div>

      {fileDetailCtl.selectedFile ? (
        <FileDetailPanel {...fileDetailCtl.panelProps} />
      ) : null}
    </>
  );
}

export function ExploreRouteView() {
  const { authUser, galleryCtl } = useAppShellContext();
  if (authUser.capabilities?.boorus === false) return <FeatureUnavailable feature="Explore" />;
  return <ExploreView onLibraryChange={galleryCtl.reloadGallery} />;
}

export function PoolRouteView() {
  const { authUser } = useAppShellContext();
  if (authUser.capabilities?.boorus === false) return <FeatureUnavailable feature="Pools" />;
  return <PoolView />;
}

export function GamesRouteView() {
  return <GamesView />;
}

// Layout for /app/settings/*: just the outlet. The index route renders the
// hub menu; each subgroup route below renders its own full page.
export function SettingsRouteView() {
  const router = useRouter();
  // Here and not in each page: the hook has to outlive the page it takes
  // the reader off, or the release of the finger finds no listener.
  useEdgeSwipeBack(
    () => router.state.location.pathname.replace(/\/$/, '') !== '/app/settings' && router.history.canGoBack()
  );
  return <Outlet />;
}

export function SettingsIndexRouteView() {
  return <SettingsMenu />;
}

export function SettingsFileSourcesRouteView() {
  const { authUser, sourceFavoritesCtl } = useAppShellContext();
  if ((authUser.capabilities?.sourceMatching ?? authUser.capabilities?.processing) === false) return <FeatureUnavailable feature="Source matching" />;
  return (
    <SettingsSubpage title="File sources">
      <div className="row g-0 settings-sections">
        <SourceFavoritesSettings {...sourceFavoritesCtl.sourceSettingsProps} />
      </div>
    </SettingsSubpage>
  );
}

export function SettingsDuplicatesRouteView() {
  const { authUser, duplicatesCtl } = useAppShellContext();
  if ((authUser.capabilities?.duplicates ?? authUser.capabilities?.processing) === false) return <FeatureUnavailable feature="Duplicate matching" />;
  return (
    <SettingsSubpage title="Matching images">
      <DuplicatesView {...duplicatesCtl.viewProps} />
      <FavoriteLinksCheck />
    </SettingsSubpage>
  );
}

export function SettingsAppearanceRouteView() {
  return (
    <SettingsSubpage title="Appearance">
      <AppearanceSettings />
    </SettingsSubpage>
  );
}

export function SettingsSyncRouteView() {
  const { authUser } = useAppShellContext();
  if (authUser.capabilities?.sync !== true) return <FeatureUnavailable feature="Backup and sync" />;
  return (
    <SettingsSubpage title="Backup & sync">
      <SyncSettings />
    </SettingsSubpage>
  );
}

export function SettingsTrashRouteView() {
  return (
    <SettingsSubpage title="Trash">
      <TrashSettings />
    </SettingsSubpage>
  );
}

export function SettingsExtraRouteView() {
  const { authUser } = useAppShellContext();
  return (
    <SettingsSubpage title="Extra">
      <div className="row g-4">
        <SettingsLoadGate section="extra">
          <ExtraSettings
            providerReportsAvailable={authUser.capabilities?.processing !== false}
            photoLibraryAvailable={authUser.capabilities?.photoLibrary === true}
          />
        </SettingsLoadGate>
      </div>
    </SettingsSubpage>
  );
}

export function SettingsBlacklistRouteView() {
  return (
    <SettingsSubpage title="Blacklist">
      <div className="row g-0 settings-sections">
        <SettingsLoadGate section="blacklist">
          <BlacklistSettings />
        </SettingsLoadGate>
      </div>
    </SettingsSubpage>
  );
}

export function SettingsShortcutsRouteView() {
  return (
    <SettingsSubpage title="Shortcuts">
      <div className="row g-0 settings-sections">
        <SettingsLoadGate section="shortcuts">
          <ShortcutSettings />
        </SettingsLoadGate>
      </div>
    </SettingsSubpage>
  );
}

export function SettingsAccountsRouteView() {
  const { authUser, sourceFavoritesCtl } = useAppShellContext();
  if (authUser.capabilities?.boorus === false) return <FeatureUnavailable feature="Booru accounts" />;
  return (
    <SettingsSubpage title="Accounts">
      <FavoritesAccountsSettings
        favoritesAvailable={authUser.capabilities?.favorites !== false}
        {...sourceFavoritesCtl.favoritesAccountsProps}
      />
    </SettingsSubpage>
  );
}

export function SettingsSubscriptionsRouteView() {
  const { authUser } = useAppShellContext();
  if (authUser.capabilities?.subscriptions === false || authUser.capabilities?.boorus === false) return <FeatureUnavailable feature="Subscriptions" />;
  return (
    <SettingsSubpage title="Subscriptions">
      <div className="row g-0 settings-sections">
        <SubscriptionsSettings />
      </div>
    </SettingsSubpage>
  );
}
