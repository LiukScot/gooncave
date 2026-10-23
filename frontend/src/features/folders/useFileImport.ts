import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { api, type UploadResult } from '@/api';

const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest('input, textarea, select') !== null);

// A copied screenshot reaches the page as "image.png" every time; a second
// paste would clash with the first in the folder.
const pastedName = (file: File, index: number) => {
  if (!/^image\.\w+$/.test(file.name)) return file;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = file.name.slice(file.name.lastIndexOf('.'));
  return new File([file], `pasted-${stamp}-${index + 1}${extension}`, { type: file.type });
};

const NOT_READY = 'Files were not added: the library is still loading. Drop or paste them again in a moment.';
const NOT_A_FILE = 'Only files can be added. Save the picture to your computer, then drop the file here.';

/**
 * Adds files dropped on the window or pasted outside a text field to
 * `folderId`. Returns whether files are being dragged over the window, to show
 * where they will land. While `folderId` is null, a drop or paste says why
 * nothing was added.
 */
export function useFileImport(folderId: string | null, onImported: () => void) {
  const [dragging, setDragging] = useState(false);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  useEffect(() => {
    let depth = 0;

    const report = ({ uploaded, rejected }: UploadResult, pending: string | number | undefined) => {
      if (uploaded.length > 0) {
        toast.success(uploaded.length === 1 ? `Added ${uploaded[0].name}` : `Added ${uploaded.length} files`, { id: pending });
        onImportedRef.current();
      }
      // With nothing added, the first refusal takes the place of the "Adding" toast.
      rejected.forEach((file, index) => {
        const replace = uploaded.length === 0 && index === 0;
        toast.error(`${file.name} was not added: ${file.reason}`, replace ? { id: pending } : undefined);
      });
    };
    const failed = (message: string, pending: string | number | undefined) =>
      toast.error(`Files were not added: ${message}`, { id: pending });
    const adding = (count: number, first?: string) =>
      toast.loading(count === 1 && first ? `Adding ${first}…` : count === 1 ? 'Adding a file…' : `Adding ${count} files…`);

    const upload = async (files: File[]) => {
      if (files.length === 0) return;
      if (!folderId) {
        toast.error(NOT_READY);
        return;
      }
      const pending = adding(files.length, files[0].name);
      try {
        report(await api.uploadFiles(folderId, files), pending);
      } catch (error) {
        failed(error instanceof Error ? error.message : String(error), pending);
      }
    };

    // A drag that starts in this page (a gallery picture) is not a file
    // arriving from outside, even though Chromium hands it over as a file.
    let fromPage = false;
    // A drag the page cancelled, like panning a zoomed picture, never starts
    // and never sends the dragend that would clear this.
    const onDragStart = (event: DragEvent) => {
      if (!event.defaultPrevented) fromPage = true;
    };
    const onDragEnd = () => {
      fromPage = false;
    };
    const filesFromOutside = (event: DragEvent) => !fromPage && hasFiles(event) && folderId !== null;
    // Text dragged into a field is the field's to take.
    const ours = (event: DragEvent) => !fromPage && (hasFiles(event) || !isTextField(event.target));
    const onDragEnter = (event: DragEvent) => {
      if (!filesFromOutside(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!filesFromOutside(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (event: DragEvent) => {
      if (!ours(event)) return;
      // Left alone, Chromium opens a dropped link or file in place of the app.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!ours(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (!hasFiles(event)) {
        toast.error(NOT_A_FILE);
        return;
      }
      void upload(Array.from(event.dataTransfer?.files ?? []));
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isTextField(event.target)) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void upload(files.map(pastedName));
    };

    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
      setDragging(false);
    };
  }, [folderId]);

  return dragging;
}
