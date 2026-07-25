import { useEffect } from 'react';

import { useAppShellContext } from './AppShell';

import { DuplicatesView } from '@/features/duplicates/DuplicatesView';
import { FavoritesAccountsSettings } from '@/features/favorites-accounts/FavoritesAccountsSettings';
import { SauceFavoritesSettings } from '@/features/favorites-sauce/SauceFavoritesSettings';
import { FileDetailPanel } from '@/features/file-detail/FileDetailPanel';
import { FoldersListPanel } from '@/features/folders/FoldersListPanel';
import { GalleryView } from '@/features/library/GalleryView';

export function GalleryRouteView() {
  const { galleryCtl, fileDetailCtl, openGalleryFile, closeGalleryFile } =
    useAppShellContext();
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
        <div className="row g-4">
          <GalleryView {...galleryCtl.viewProps} onFileOpen={openGalleryFile} />
        </div>
      )}

      {fileDetailCtl.selectedFile ? (
        <FileDetailPanel
          {...fileDetailCtl.panelProps}
          onClose={closeGalleryFile}
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
