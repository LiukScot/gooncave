import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { API_BASE, api } from '@/api';
import { useConfirm } from '@/components/confirm-dialog';
import { basenameFromPath } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';


const DAY_MS = 24 * 60 * 60 * 1000;

function daysLeft(purgeAt: string): string {
  const days = Math.ceil((new Date(purgeAt).getTime() - Date.now()) / DAY_MS);
  if (days <= 0) return 'Deleted for good on the next check';
  return days === 1 ? '1 day left' : `${days} days left`;
}

/** The trash switch for the Extra page. */
export function TrashToggle() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: queryKeys.trash.settings(), queryFn: api.getTrashSettings });
  const update = useMutation({
    mutationFn: api.updateTrashSettings,
    onSuccess: (value) => client.setQueryData(queryKeys.trash.settings(), value)
  });
  const days = settings.data?.days ?? 14;

  return (
    <div className="list-group-item flex items-center gap-3">
        <span className="flex-1 min-w-0">
          <label className="block font-medium" htmlFor="extra-trash">Trash</label>
          <span className="block text-muted-foreground text-xs">
            Deleted files wait {days} days on every device before they go for good, together with their booru
            favorites. Off: deleting removes them at once.
          </span>
          {settings.isError ? (
            <span className="block text-destructive text-xs" role="alert">
              The trash setting could not be loaded: {settings.error.message}{' '}
              <button className="btn btn-link btn-sm p-0 align-baseline" type="button" disabled={settings.isFetching}
                onClick={() => void settings.refetch()}>Load it again</button>
            </span>
          ) : null}
          {update.isError ? (
            <span className="block text-destructive text-xs" role="alert">{update.error.message}</span>
          ) : null}
        </span>
        <input className="form-check-input shrink-0" type="checkbox" id="extra-trash" name="trash"
          checked={settings.data?.enabled ?? true} disabled={!settings.data || update.isPending}
          onChange={() => settings.data && update.mutate(!settings.data.enabled)} />
    </div>
  );
}

/** The files in the trash, with restore and empty. */
export function TrashSettings() {
  const client = useQueryClient();
  const confirm = useConfirm();
  const trash = useQuery({ queryKey: queryKeys.trash.files(), queryFn: api.getTrash });
  const changed = () => Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.trash.files() }),
    client.invalidateQueries({ queryKey: queryKeys.files.all })
  ]);
  const restore = useMutation({ mutationFn: api.restoreFile, onSuccess: changed });
  const empty = useMutation({ mutationFn: api.emptyTrash, onSuccess: changed });

  if (trash.isPending) return <p className="text-muted-foreground text-sm" role="status">Loading the trash…</p>;
  if (trash.isError) {
    return (
      <div className="list-group">
        <div className="list-group-item">
          <p className="text-sm">The trash could not be loaded: {trash.error.message}</p>
          <button className="btn btn-outline-light btn-sm mt-2" type="button" disabled={trash.isFetching}
            onClick={() => void trash.refetch()}>Load it again</button>
        </div>
      </div>
    );
  }

  const { files, days } = trash.data;
  const emptyTrash = async () => {
    const confirmed = await confirm(
      `Deletes ${files.length === 1 ? 'this file' : `these ${files.length} files`} for good on every device, and removes the matching posts from your booru favorites where reverse sync is on.`,
      { title: 'Empty the trash?', confirmLabel: 'Empty trash', destructive: true }
    );
    if (confirmed) empty.mutate();
  };

  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-sm">
        Deleted files stay here for {days} days on every device. Restore one to put it back in the gallery.
      </p>
      {files.length === 0 ? (
        <div className="list-group">
          <p className="list-group-item text-muted-foreground text-sm">The trash is empty.</p>
        </div>
      ) : (
        <>
          <ul className="list-group">
            {files.map((file) => (
              <li key={file.sha256} className="list-group-item flex items-center gap-3">
                {file.thumbUrl ? (
                  <img src={`${API_BASE}${file.thumbUrl}`} alt="" className="trash-thumb shrink-0" loading="lazy" />
                ) : (
                  <span className="trash-thumb shrink-0" aria-hidden="true" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate">{basenameFromPath(file.path)}</span>
                  <span className="block text-muted-foreground text-xs">{daysLeft(file.purgeAt)}</span>
                </span>
                <button className="btn btn-outline-light btn-sm shrink-0" type="button"
                  disabled={restore.isPending} onClick={() => restore.mutate(file.sha256)}>Restore</button>
              </li>
            ))}
          </ul>
          <div>
            <button className="btn btn-outline-danger btn-sm" type="button" disabled={empty.isPending}
              onClick={() => void emptyTrash()}>
              {empty.isPending ? 'Emptying…' : 'Empty trash'}
            </button>
          </div>
        </>
      )}
      {restore.error || empty.error ? (
        <p className="text-destructive text-sm" role="alert">{(restore.error ?? empty.error)?.message}</p>
      ) : null}
    </div>
  );
}
