import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api';
import type { KeepPreview, Originals } from '@/api';
import { useConfirm } from '@/components/confirm-dialog';
import { PillSwitch } from '@/components/pill-switch';
import { formatBytes } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';


const KEY = queryKeys.originals;

const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

function statusText(status: Originals['status']): string | null {
  const progress = status.total ? ` ${status.done ?? 0} of ${status.total}` : '';
  if (status.state === 'uploading') return `Uploading pictures and videos to the folder…${progress}`;
  if (status.state === 'downloading') return `Downloading pictures and videos to this device…${progress}`;
  return null;
}

export function OriginalsSettings() {
  const client = useQueryClient();
  const confirm = useConfirm();
  const originals = useQuery({
    queryKey: KEY,
    queryFn: api.getOriginals,
    refetchInterval: (query) => {
      const state = query.state.data?.status.state;
      return state === 'uploading' || state === 'downloading' ? 2000 : 10000;
    }
  });
  const update = useMutation({
    mutationFn: api.updateOriginals,
    onSuccess: (value) => client.setQueryData(KEY, value)
  });
  const preview = useMutation({ mutationFn: api.previewKeepAll });

  if (originals.isPending) {
    return <p className="list-group-item text-muted-foreground text-sm" role="status">Counting your files…</p>;
  }
  if (originals.isError) {
    return (
      <div className="list-group-item">
        <p className="text-sm">These settings could not be loaded: {originals.error.message}</p>
        <button className="btn btn-outline-light btn-sm mt-2" type="button" disabled={originals.isFetching}
          onClick={() => void originals.refetch()}>Load them again</button>
      </div>
    );
  }

  const value = originals.data;
  const progress = statusText(value.status);
  const error = update.error?.message ?? preview.error?.message;

  const toggleKeepAll = () => {
    const keepAll = !value.keepAll;
    // mutate, not mutateAsync: a failed preview shows through preview.error instead of rejecting.
    preview.mutate(keepAll, { onSuccess: (change) => void confirmKeepAll(keepAll, change) });
  };

  const confirmKeepAll = async (keepAll: boolean, change: KeepPreview) => {
    const message = keepAll
      ? change.download.files > 0
        ? `GoonCave downloads ${files(change.download.files)} (${formatBytes(change.download.bytes)}) to this device.`
        : null
      : change.free.files > 0
        ? `Up to ${files(change.free.files)} (${formatBytes(change.free.bytes)}) leave this device: booru favorites at once, other files once the folder has a copy. They stay in the gallery and download when you open them.`
        : null;
    if (message && !(await confirm(message, {
      title: keepAll ? 'Keep every file here?' : 'Stop keeping every file?',
      confirmLabel: keepAll ? 'Download them' : 'Free the space'
    }))) return;
    update.mutate({ keepAll });
  };

  return (
    <>
      <div className="list-group-item flex items-center gap-3">
        <span className="flex-1 min-w-0">
          <label className="block font-medium" htmlFor="originals-upload">Sync pictures and videos</label>
          <span className="block text-muted-foreground text-xs">
            {value.folderConnected
              ? `Uploads each file to the folder, so every device can open it. Needs about ${formatBytes(value.localBytes)} there. Off: only tags, votes and settings sync.`
              : 'Connect a WebDAV folder above first: the files go there.'}
          </span>
        </span>
        <PillSwitch   id="originals-upload" name="originals-upload"
          checked={value.upload} disabled={!value.folderConnected || update.isPending}
          onChange={() => update.mutate({ upload: !value.upload })} />
      </div>

      <div className="list-group-item flex items-center gap-3">
        <span className="flex-1 min-w-0">
          <label className="block font-medium" htmlFor="originals-keep-all">Keep every file on this device</label>
          <span className="block text-muted-foreground text-xs">
            The gallery always shows your whole library. Off: booru favorites leave this device, and other
            files leave once the folder has a copy; each downloads again when you open it. Keep single files
            from their detail view.
            {value.keepAll === value.defaultKeepAll ? null : ` Default here: ${value.defaultKeepAll ? 'on' : 'off'}.`}
          </span>
        </span>
        <PillSwitch   id="originals-keep-all" name="originals-keep-all"
          checked={value.keepAll} disabled={update.isPending || preview.isPending}
          onChange={toggleKeepAll} />
      </div>

      {progress || value.status.error || error ? (
        <div className="list-group-item">
          {progress ? <p className="text-muted-foreground text-xs" role="status" aria-live="polite">{progress}</p> : null}
          {value.status.error ? (
            <p className="text-destructive text-sm break-words" role="alert">
              Moving files stopped: {value.status.error} GoonCave tries again every minute.
            </p>
          ) : null}
          {error ? <p className="text-destructive text-sm break-words" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </>
  );
}
