import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useRef } from 'react';

import { api } from '@/api';
import type { ImportResult } from '@/api';
import { HelpPopover } from '@/components/HelpPopover';

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
    return imported ? <p className="text-sm mt-2" role="status">Restored. Everything in the file is now on this device.</p> : null;
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

  return (
    <div className="list-group-item">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn btn-outline-light btn-sm inline-flex items-center gap-2" type="button" disabled={download.isPending}
          onClick={() => download.mutate()}>
          <Download className="size-4" aria-hidden="true" />
          {download.isPending ? 'Backing up…' : 'Back up'}
        </button>
        <button className="btn btn-outline-light btn-sm inline-flex items-center gap-2" type="button" disabled={restore.isPending}
          onClick={() => picker.current?.click()}>
          <Upload className="size-4" aria-hidden="true" />
          {restore.isPending ? 'Restoring…' : 'Restore'}
        </button>
        <input ref={picker} className="visually-hidden" type="file" name="backup" accept=".gz,application/gzip"
          tabIndex={-1} aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) restore.mutate(file);
          }} />
        <HelpPopover
          text="A file with your tags, votes, favorites, read marks, sources, sites and shared settings. It holds no booru passwords, keys or media files. Restoring one adds and updates records; nothing on this device is deleted. Records of files GoonCave has not read yet apply as the library scan reads them."
        />
      </div>
      {download.isSuccess ? (
        <p className="text-sm mt-2 break-words" role="status">
          Saved as {download.data}. It is in your Downloads folder, unless your browser asked you to choose another.
        </p>
      ) : null}
      <WaitingRecords imported={restore.isSuccess} />
      {download.error ?? restore.error ? (
        <p className="text-destructive text-sm mt-2 break-words" role="alert">
          {(download.error ?? restore.error)?.message}
        </p>
      ) : null}
    </div>
  );
}
