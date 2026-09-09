import { useLocation, type useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, type MutableRefObject } from 'react';

import type { FileItem } from '@/api';
import type { GalleryControllerOutput } from '@/features/library/useGalleryController';
import type { GalleryExcursionNav } from '@/stores/exploreUiStore';

type GalleryExploreBridgeArgs = {
  galleryControllerRef: MutableRefObject<GalleryControllerOutput | null>;
  selectedFileRef: MutableRefObject<FileItem | null>;
  openFileRef: MutableRefObject<(file: FileItem) => void>;
  navigate: ReturnType<typeof useNavigate>;
  setGalleryBridge: (bridge: GalleryExcursionNav | null) => void;
};

/** Publishes Gallery's sequence while a Gallery detail is open in Explore. */
export function useGalleryExploreBridge({
  galleryControllerRef,
  selectedFileRef,
  openFileRef,
  navigate,
  setGalleryBridge
}: GalleryExploreBridgeArgs) {
  const onGalleryRoute = useLocation({
    select: (state) => state.pathname === '/app/gallery'
  });
  const galleryCtl = galleryControllerRef.current;
  const selectedFileId = selectedFileRef.current?.id;
  const currentIndex = selectedFileId
    ? (galleryCtl?.selectedFileIndex(selectedFileId) ?? -1)
    : -1;

  const openRelative = useCallback(
    async (anchorId: string, delta: number) => {
      let controller = galleryControllerRef.current;
      if (!controller) return;
      let anchorIndex = controller.selectedFileIndex(anchorId);
      let target = controller.galleryFiles[anchorIndex + delta];
      if (!target && delta > 0 && controller.galleryHasMore) {
        await controller.goRelative(anchorId, delta);
        controller = galleryControllerRef.current;
        if (!controller) return;
        anchorIndex = controller.selectedFileIndex(anchorId);
        target = controller.galleryFiles[anchorIndex + delta];
      }
      if (!target) return;
      await navigate({
        to: '/app/gallery',
        replace: true,
        search: { fileId: target.id, fs: undefined }
      });
      openFileRef.current(target);
    },
    [galleryControllerRef, navigate, openFileRef]
  );

  useEffect(() => {
    if (!onGalleryRoute || !galleryCtl || !selectedFileId || currentIndex < 0) {
      setGalleryBridge(null);
      return;
    }
    setGalleryBridge({
      backLabel: 'Back to gallery',
      hasPrev: currentIndex > 0,
      hasNext:
        currentIndex < galleryCtl.galleryFiles.length - 1 ||
        galleryCtl.galleryHasMore,
      goRelative: (delta) => {
        void openRelative(selectedFileId, delta);
      },
      close: () => {
        void navigate({
          to: '/app/gallery',
          replace: true,
          search: { fileId: undefined, fs: undefined }
        });
      }
    });
    return () => setGalleryBridge(null);
  }, [
    currentIndex,
    galleryCtl,
    navigate,
    onGalleryRoute,
    openRelative,
    selectedFileId,
    setGalleryBridge
  ]);
}
