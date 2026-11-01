import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, HardDrive, MoreHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/api';
import type { FileItem } from '@/api';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { queryKeys } from '@/lib/query-keys';

/**
 * The less frequent actions on an open file, behind one button. Keeping it on
 * this device is left out when the device keeps every file, where it would
 * change nothing. Its icon says whether the file is kept; an original that is
 * here only for now keeps the cloud, because it can still leave. The hooks stay
 * outside the menu, so a download goes on being shown after the menu closes.
 */
export function FileMoreMenu({
  file,
  onKept,
  deleting,
  deleteTitle,
  onDelete
}: {
  file: FileItem;
  onKept: (fileId: string, locationType: FileItem['locationType']) => void;
  deleting: boolean;
  deleteTitle: string;
  onDelete: () => void;
}) {
  const client = useQueryClient();
  const key = [...queryKeys.files.all, file.id, 'kept'] as const;
  const originals = useQuery({ queryKey: queryKeys.originals, queryFn: api.getOriginals });
  // While the setting is unknown the item waits; if it cannot be read, the item still works.
  const keepsEverything = originals.isError ? false : originals.data?.keepAll !== false;
  const kept = useQuery({ queryKey: key, queryFn: () => api.getKept(file.id), enabled: !keepsEverything });
  const update = useMutation({
    mutationFn: (value: boolean) => api.setKept(file.id, value),
    onSuccess: ({ kept: value, locationType }) => {
      client.setQueryData(key, value);
      onKept(file.id, locationType);
      toast.success(
        value
          ? 'Downloaded and kept on this device'
          : locationType === 'REMOTE'
            ? 'No longer kept: removed from this device'
            : 'No longer kept: it can be removed from this device to free space'
      );
    },
    onError: (error) => toast.error(`The file could not be kept on this device: ${error.message}`)
  });

  const on = kept.data === true;
  const here = file.locationType === 'LOCAL';
  const KeepIcon = on ? HardDrive : CloudDownload;
  const keepLabel = update.isPending
    ? update.variables ? 'Downloading to this device…' : 'Updating this device…'
    : on ? 'Stop keeping on this device'
      : here ? 'Keep on this device'
        : 'Download and keep on this device';

  return (
    // Not modal: a modal menu locks the page's scroll, which moves it under the reader.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        className="file-detail-overlay-btn"
        aria-label="More actions"
        title="More actions"
        aria-busy={update.isPending}
      >
        <MoreHorizontal className="file-detail-overlay-icon" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="file-detail-more-menu" side="top" align="end" sideOffset={8}>
        {keepsEverything ? null : (
          <DropdownMenuItem
            disabled={kept.isPending || update.isPending}
            title={on || !here ? undefined : 'On this device for now, removed when space is freed'}
            // Stays open: the label is what shows the download going on.
            onSelect={(event) => {
              event.preventDefault();
              update.mutate(!on);
            }}
          >
            <KeepIcon aria-hidden="true" />
            {keepLabel}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="file-detail-delete-button"
          variant="destructive"
          disabled={deleting}
          title={deleteTitle}
          onSelect={onDelete}
        >
          <Trash2 aria-hidden="true" />
          {deleting ? 'Deleting file…' : 'Delete file'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
