import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, uploadResultSchema, type UploadResult } from '@/api';

const shellDropSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('over') }),
  z.object({ state: z.literal('left') }),
  z.object({ state: z.literal('adding'), count: z.number().int().nonnegative() }),
  z.object({ state: z.literal('done'), result: uploadResultSchema }),
  z.object({ state: z.literal('failed'), error: z.string() })
]);

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

const report = (
  { uploaded, rejected }: UploadResult,
  pending: string | number | undefined,
  onImported: () => void
) => {
  if (uploaded.length > 0) {
    toast.success(uploaded.length === 1 ? `Added ${uploaded[0].name}` : `Added ${uploaded.length} files`, { id: pending });
    onImported();
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

const importFiles = async (folderId: string, files: File[], onImported: () => void) => {
  if (files.length === 0) return;
  const pending = adding(files.length, files[0].name);
  try {
    report(await api.uploadFiles(folderId, files), pending, onImported);
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error), pending);
  }
};

const importFromPhotos = async (onImported: () => void) => {
  try {
    const result = await api.addFromPhotos();
    report(result, undefined, onImported);
    if (result.deleteError) toast.error(`The originals were not deleted from Photos: ${result.deleteError}`);
    else if (result.deleted > 0) {
      toast.success(result.deleted === 1 ? 'Deleted the original from Photos' : `Deleted ${result.deleted} originals from Photos`);
    }
  } catch (error) {
    failed(error instanceof Error ? error.message : String(error), undefined);
  }
};

/**
 * Adds files dropped on the window or pasted outside a text field to
 * `folderId`. Returns whether files are being dragged over the window, to show
 * where they will land, `addFiles` for files the person picked, and `addFromPhotos` to pick from
 * the iPhone's photo library, where the originals can be deleted. Both do
 * nothing while `folderId` is null.
 */
export function useFileImport(folderId: string | null, onImported: () => void) {
  const [dragging, setDragging] = useState(false);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const addFiles = useCallback(
    (files: File[]) => {
      if (folderId) void importFiles(folderId, files, () => onImportedRef.current());
    },
    [folderId]
  );

  const addFromPhotos = useCallback(() => {
    if (folderId) void importFromPhotos(() => onImportedRef.current());
  }, [folderId]);

  useEffect(() => {
    if (!folderId) return;
    let depth = 0;
    const upload = (files: File[]) => importFiles(folderId, files, () => onImportedRef.current());

    // The desktop app takes drops and pastes from the file manager itself (desktop/shell/src/import.rs),
    // and the iPhone app adds files from the share sheet (ios/src-tauri/src/share.rs).
    // A failure can arrive without an "adding" message, so the pending toast is cleared once used.
    let shellPending: string | number | undefined;
    const onShellDrop = (event: Event) => {
      const detail = shellDropSchema.safeParse((event as CustomEvent<unknown>).detail);
      if (!detail.success) {
        console.error('Unexpected drop message from the desktop app', detail.error);
        return;
      }
      const message = detail.data;
      if (message.state === 'over' || message.state === 'left') {
        setDragging(message.state === 'over');
      } else if (message.state === 'adding') {
        setDragging(false);
        shellPending = adding(message.count);
      } else if (message.state === 'done') {
        report(message.result, shellPending, () => onImportedRef.current());
        shellPending = undefined;
      } else {
        failed(message.error, shellPending);
        shellPending = undefined;
      }
    };

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      void upload(Array.from(event.dataTransfer?.files ?? []));
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isTextField(event.target)) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void upload(files.map(pastedName));
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    window.addEventListener('gooncave-drop', onShellDrop);
    return () => {
      window.removeEventListener('gooncave-drop', onShellDrop);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
      setDragging(false);
    };
  }, [folderId]);

  return { dragging, addFiles, addFromPhotos };
}
