import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, HardDrive, HardDriveDownload } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/api';
import type { FileItem } from '@/api';
import { queryKeys } from '@/lib/query-keys';


/**
 * Keeps the open file on this device. Hidden when the device keeps every file,
 * where it would change nothing. The icon says whether the original is here.
 */
export function KeepOnDeviceButton({ file, onKept }: { file: FileItem; onKept: (fileId: string, locationType: FileItem['locationType']) => void }) {
  const client = useQueryClient();
  const key = [...queryKeys.files.all, file.id, 'kept'] as const;
  const originals = useQuery({ queryKey: queryKeys.originals, queryFn: api.getOriginals });
  // While the setting is unknown the button waits; if it cannot be read, the button still works.
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
  if (keepsEverything) return null;

  const on = kept.data === true;
  const here = file.locationType === 'LOCAL';
  const label = update.isPending
    ? 'Downloading to this device…'
    : on ? 'Downloaded and kept on this device. Stop keeping it'
      : here ? 'On this device for now, removed when space is freed. Keep it here'
        : 'Not on this device. Download it and keep it here';
  const Icon = on ? HardDrive : here ? HardDriveDownload : CloudDownload;

  return (
    <button
      type="button"
      className={`btn btn-sm file-detail-icon-button ${on ? 'btn-light' : 'btn-outline-light'}`}
      disabled={kept.isPending || update.isPending}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => update.mutate(!on)}
    >
      <Icon className={`size-4${update.isPending ? ' animate-pulse motion-reduce:animate-none' : ''}`} aria-hidden="true" />
    </button>
  );
}
