import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import { api } from '@/api';
import type { ImportResult } from '@/api';
import { useErrorToast } from '@/lib/useErrorToast';

const inputClass = 'form-control form-control-sm bg-background text-foreground border-secondary';
const PROGRESS_KEY = ['library', 'progress'] as const;
const count = (value: number) => new Intl.NumberFormat().format(value);
const records = (value: number) => (value === 1 ? '1 record' : `${count(value)} records`);

/** Live state of records that wait for their files, shown after an import and while any wait. */
function WaitingRecords({ imported }: { imported: boolean }) {
  const progress = useQuery({
    queryKey: PROGRESS_KEY,
    queryFn: api.getLibraryProgress,
    refetchInterval: (query) => (query.state.data?.waiting ? 3000 : false)
  });
  const value = progress.data;
  if (!value) return null;
  if (value.waiting === 0) {
    return imported ? <p className="text-sm mt-2" role="status">Imported. Everything in the file is now on this device.</p> : null;
  }
  // `found` stays 0 until the first walk of the library folder after start finishes.
  const counting = value.scanning && value.found === 0;
  const reading = value.scanning && value.files < value.found;
  return (
    <div className="mt-3" role="status">
      {counting || reading ? (
        <>
          <p className="text-sm">
            {counting
              ? 'Counting the files in the library folder…'
              : `Reading library files: ${count(value.files)} of ${count(value.found)}`}
          </p>
          {counting ? (
            <progress className="progress mt-2" aria-label="Library files read" />
          ) : (
            <progress className="progress mt-2" aria-label="Library files read" max={value.found} value={value.files} />
          )}
          <p className="text-muted-foreground text-xs mt-2">
            Tags, votes and favorites belong to files, so {records(value.waiting)} wait until GoonCave reads their
            file and then apply on their own. A large library takes a while. Keep GoonCave open: closing it pauses
            the work, and it continues on the next start.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm">{records(value.waiting)} wait to be applied:</p>
          <ul className="text-sm mt-1 list-disc ps-4">
            {value.waitingFor.missingFiles > 0 && (
              <li>
                {records(value.waitingFor.missingFiles)} for files this device does not have yet. They apply when sync or
                the library folder brings those files.
              </li>
            )}
            {value.waitingFor.missingSites > 0 && (
              <li>
                {records(value.waitingFor.missingSites)} for sites this device does not have. They apply when you add
                those sites in Accounts.
              </li>
            )}
            {value.waitingFor.other > 0 && (
              <li>{records(value.waitingFor.other)} for another reason, such as a setting from a newer GoonCave.</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The webview may still be reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function useImport<T>(run: (input: T) => Promise<ImportResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    // Votes, tags and favorites may have changed on every screen.
    onSuccess: () => void client.invalidateQueries()
  });
}

export function BackupFile() {
  const picker = useRef<HTMLInputElement>(null);
  const download = useMutation({
    mutationFn: async () => {
      const name = `gooncave-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
      saveFile(await api.downloadBackup(), name);
      return name;
    }
  });
  const restore = useImport(api.importBackup);
  useErrorToast(download.error ?? restore.error);

  return (
    <div className="list-group-item">
      <p className="text-muted-foreground text-xs">
        A file with your tags, votes, favorites, read marks, sources, sites and shared settings. It holds no
        booru passwords, keys or media files. Importing one adds and updates records; nothing on this device is
        deleted. Records of files GoonCave has not read yet apply as the library scan reads them.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn btn-outline-light btn-sm" type="button" disabled={download.isPending}
          onClick={() => download.mutate()}>
          {download.isPending ? 'Preparing the backup…' : 'Download backup'}
        </button>
        <button className="btn btn-outline-light btn-sm" type="button" disabled={restore.isPending}
          onClick={() => picker.current?.click()}>
          {restore.isPending ? 'Importing…' : 'Import backup'}
        </button>
        <input ref={picker} className="visually-hidden" type="file" name="backup" accept=".gz,application/gzip"
          tabIndex={-1} aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) restore.mutate(file);
          }} />
      </div>
      {download.isSuccess ? (
        <p className="text-sm mt-2 break-words" role="status">
          Saved as {download.data}. It is in your Downloads folder, unless your browser asked you to choose another.
        </p>
      ) : null}
      <WaitingRecords imported={restore.isSuccess} />
    </div>
  );
}

export function OldServerImport() {
  const [username, setUsername] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const ids = { username: useId(), file: useId() };
  const takeOver = useImport(api.importOldDatabase);
  useErrorToast(takeOver.error);

  return (
    <form className="list-group-item" onSubmit={(event) => {
      event.preventDefault();
      if (file) takeOver.mutate({ username, file });
    }}>
      <ol className="text-muted-foreground text-xs list-decimal ps-4 grid gap-1">
        <li>Stop the old server and copy its database file: storage/data.db, or the file named by DATA_FILE.</li>
        <li>Copy its media files into this device&apos;s library folder. Records of files still missing wait for them.</li>
        <li>Choose the database file and enter the user name you log in with there.</li>
      </ol>
      <div className="grid gap-3 mt-3 sm:grid-cols-2">
        <div>
          <label className="form-label text-sm mb-1 text-muted-foreground" htmlFor={ids.username}>
            User name on the old server
          </label>
          <input id={ids.username} name="username" type="text" required autoComplete="off" className={inputClass}
            value={username} onChange={(event) => setUsername(event.target.value)} />
        </div>
        <div>
          <label className="form-label text-sm mb-1 text-muted-foreground" htmlFor={ids.file}>Database file</label>
          <input id={ids.file} name="database" type="file" required className={inputClass}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
        </div>
      </div>
      <button className="btn btn-outline-light btn-sm mt-3" type="submit"
        disabled={takeOver.isPending || !file || !username.trim()}>
        {takeOver.isPending ? 'Importing from the old server…' : 'Import from the old server'}
      </button>
      <p className="text-muted-foreground text-xs mt-2">
        Votes, tags, favorites, read marks, sources, sites with their keys and shared settings come over. Settings
        kept per device, such as grid columns, stay as they are here.
      </p>
      {takeOver.data ? (
        <p className="text-sm mt-2" role="status">
          {takeOver.data.waiting === 0
            ? 'Imported. Everything from the old server is now on this device.'
            : 'Imported. The progress of records waiting for their files shows under Backup file.'}
        </p>
      ) : null}
    </form>
  );
}
