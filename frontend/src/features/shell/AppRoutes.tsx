import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

import { useAppShellContext } from './AppShell';
import {
  getGalleryDetailSyncAction,
  shouldApplyFileIdToSelection
} from './galleryDetailSync';

import { DuplicatesView } from '@/features/duplicates/DuplicatesView';
import { FavoritesAccountsSettings } from '@/features/favorites-accounts/FavoritesAccountsSettings';
import { SauceFavoritesSettings } from '@/features/favorites-sauce/SauceFavoritesSettings';
import { FileDetailPanel } from '@/features/file-detail/FileDetailPanel';
import { FoldersListPanel } from '@/features/folders/FoldersListPanel';
import { GalleryView } from '@/features/library/GalleryView';

export function GalleryRouteView() {
  const { galleryCtl, fileDetailCtl, openGalleryFile } = useAppShellContext();
  const navigate = useNavigate({ from: '/app/gallery' });
  const { fileId } = useSearch({ from: '/app/gallery' });
  const previousFileIdRef = useRef<string | undefined>(fileId);
  const selectedFileId = fileDetailCtl.selectedFile?.id;
  const { closeFile } = fileDetailCtl;
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
      closeFile({ syncUrl: false });
    },
    [closeFile]
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
