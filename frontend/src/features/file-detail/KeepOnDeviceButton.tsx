import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDriveDownload } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/api';
import type { FileItem } from '@/api';
import { queryKeys } from '@/lib/query-keys';


/** Keeps the open file on this device even when the device does not keep every file. */
export function KeepOnDeviceButton({ file, onKept }: { file: FileItem; onKept: (fileId: string) => void }) {
  const client = useQueryClient();
  const key = [...queryKeys.files.all, file.id, 'kept'] as const;
  const kept = useQuery({ queryKey: key, queryFn: () => api.getKept(file.id) });
  const update = useMutation({
    mutationFn: (value: boolean) => api.setKept(file.id, value),
    onSuccess: (value) => {
      client.setQueryData(key, value);
      // Keeping resolves once the original is here; stopping leaves it until the next clean-up.
      if (value) onKept(file.id);
      toast.success(value ? 'Kept on this device' : 'This device keeps it only if the setting says so');
    },
    onError: (error) => toast.error(`The file could not be kept on this device: ${error.message}`)
  });
  const on = kept.data === true;
  const label = update.isPending
    ? 'Downloading to this device'
    : on ? 'Kept on this device: stop keeping it' : 'Keep on this device';

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
      <HardDriveDownload className="size-4" aria-hidden="true" />
    </button>
  );
}
