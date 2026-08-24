import { Navigate, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useAppShellContext } from './AppShell';

import { DuplicatesView } from '@/features/duplicates/DuplicatesView';
import { ExploreView } from '@/features/explore/ExploreView';
import { FavoritesAccountsSettings } from '@/features/favorites-accounts/FavoritesAccountsSettings';
import { SauceFavoritesSettings } from '@/features/favorites-sauce/SauceFavoritesSettings';
import { FileDetailPanel } from '@/features/file-detail/FileDetailPanel';
import { FoldersListPanel } from '@/features/folders/FoldersListPanel';
import { GamesView } from '@/features/games/GamesView';
import { GalleryView } from '@/features/library/GalleryView';
import { ExtraSettings } from '@/features/settings/ExtraSettings';
import { SettingsMenu } from '@/features/settings/SettingsMenu';
import { SettingsSubpage } from '@/features/settings/SettingsSubpage';
import { TagDatabaseSettings } from '@/features/settings/TagDatabaseSettings';
import { useExtraSettings } from '@/hooks/settings';

export function GalleryRouteView() {
  const { galleryCtl, fileDetailCtl, openGalleryFile } = useAppShellContext();
  const { closeFile } = fileDetailCtl;

  // Leaving the gallery route drops the selection; the URL it came from is
  // already gone, so do not try to rewrite it.
  useEffect(
    () => () => {
      closeFile({ syncUrl: false });
    },
    [closeFile]
  );

  return (
    <>
      {fileDetailCtl.selectedFile ? null : (
        <div className="page-chrome">
          <h1 className="uppercase font-semibold file-detail-section-title mb-4">
            Gallery
          </h1>
          <div className="row g-4">
            <GalleryView
              {...galleryCtl.viewProps}
              onFileOpen={openGalleryFile}
            />
          </div>
        </div>
      )}

      {fileDetailCtl.selectedFile ? (
        <FileDetailPanel {...fileDetailCtl.panelProps} />
      ) : null}
    </>
  );
}

export function ExploreRouteView() {
  return <ExploreView />;
}

export function GamesRouteView() {
  const { gamesTabEnabled } = useExtraSettings();
  // The tab is hidden when disabled; a stale bookmark or back-button entry
  // still lands here, so send it somewhere that exists.
  if (!gamesTabEnabled) {
    return (
      <Navigate
        to="/app/gallery"
        replace
        search={{ fileId: undefined, fs: undefined }}
      />
    );
  }
  return <GamesView />;
}

// Layout for /app/settings/*: just the outlet. The index route renders the
// hub menu; each subgroup route below renders its own full page.
export function SettingsRouteView() {
  return <Outlet />;
}

export function SettingsIndexRouteView() {
  return <SettingsMenu />;
}

export function SettingsFoldersRouteView() {
  const { foldersCtl } = useAppShellContext();
  return (
    <SettingsSubpage title="Folders">
      <div className="row g-0 settings-sections">
        <FoldersListPanel {...foldersCtl.panelProps} />
      </div>
    </SettingsSubpage>
  );
}

export function SettingsSyncRouteView() {
  const { sauceFavoritesCtl } = useAppShellContext();
  return (
    <SettingsSubpage title="Sync">
      <div className="row g-0 settings-sections">
        <SauceFavoritesSettings {...sauceFavoritesCtl.sauceSettingsProps} />
      </div>
    </SettingsSubpage>
  );
}

export function SettingsDuplicatesRouteView() {
  const { duplicatesCtl } = useAppShellContext();
  return (
    <SettingsSubpage title="Duplicates">
      <div className="row g-4">
        <DuplicatesView {...duplicatesCtl.viewProps} />
      </div>
    </SettingsSubpage>
  );
}

export function SettingsExtraRouteView() {
  return (
    <SettingsSubpage title="Extra">
      <div className="row g-4">
        <ExtraSettings />
      </div>
    </SettingsSubpage>
  );
}

export function SettingsTagsRouteView() {
  return (
    <SettingsSubpage title="Tags">
      <div className="row g-0 settings-sections">
        <TagDatabaseSettings />
      </div>
    </SettingsSubpage>
  );
}

export function SettingsFavoritesRouteView() {
  const { sauceFavoritesCtl } = useAppShellContext();
  return (
    <SettingsSubpage title="Favorites accounts">
      <FavoritesAccountsSettings
        {...sauceFavoritesCtl.favoritesAccountsProps}
      />
    </SettingsSubpage>
  );
}
