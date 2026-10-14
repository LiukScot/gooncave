import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { BackupFile, OldServerImport } from './BackupSettings';

import { api } from '@/api';
import type { SyncSettings as Saved } from '@/api';


const SETTINGS_KEY = ['sync', 'settings'] as const;
const STATUS_KEY = ['sync', 'status'] as const;
const inputClass = 'form-control form-control-sm bg-background text-foreground border-secondary';
const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

function ConnectForm({ saved, onDone }: { saved: Saved; onDone?: () => void }) {
  const client = useQueryClient();
  const [url, setUrl] = useState(saved.url ?? '');
  const [username, setUsername] = useState(saved.username ?? '');
  const [password, setPassword] = useState('');
  const ids = { url: useId(), username: useId(), password: useId() };
  const connect = useMutation({
    mutationFn: () => api.connectSync({ url, username, ...(password || !saved.hasPassword ? { password } : {}) }),
    onSuccess: (value) => {
      client.setQueryData(SETTINGS_KEY, value);
      void client.invalidateQueries({ queryKey: STATUS_KEY });
      setPassword('');
      onDone?.();
    }
  });

  return (
    <form
      className="grid gap-3 mt-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        connect.mutate();
      }}
    >
      <div className="sm:col-span-2">
        <label className="form-label text-sm mb-1 text-muted-foreground" htmlFor={ids.url}>Folder address</label>
        <input id={ids.url} name="url" type="url" required inputMode="url" autoComplete="url" className={inputClass}
          placeholder="https://cloud.example.org/remote.php/dav/files/you/GoonCave" value={url}
          onChange={(event) => setUrl(event.target.value)} />
      </div>
      <div>
        <label className="form-label text-sm mb-1 text-muted-foreground" htmlFor={ids.username}>User name</label>
        <input id={ids.username} name="username" type="text" autoComplete="username" className={inputClass}
          value={username} onChange={(event) => setUsername(event.target.value)} />
      </div>
      <div>
        <label className="form-label text-sm mb-1 text-muted-foreground" htmlFor={ids.password}>
          Password{saved.hasPassword ? ' · saved' : ''}
        </label>
        <input id={ids.password} name="password" type="password" autoComplete="current-password" className={inputClass}
          placeholder={saved.hasPassword ? 'Leave empty to keep the saved one' : ''} value={password}
          onChange={(event) => setPassword(event.target.value)} />
      </div>
      <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-outline-light btn-sm" type="submit" disabled={connect.isPending || !url.trim()}>
          {connect.isPending ? 'Checking the folder…' : saved.url ? 'Save and sync' : 'Connect folder'}
        </button>
        {onDone ? (
          <button className="btn btn-link btn-sm" type="button" onClick={onDone}>Cancel</button>
        ) : null}
      </div>
      {connect.error ? (
        <p className="sm:col-span-2 text-destructive text-sm break-words" role="alert">{connect.error.message}</p>
      ) : null}
    </form>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h2 className="h5 mb-3" id={id}>{title}</h2>
      <div className="list-group list-group-segmented">{children}</div>
    </section>
  );
}

export function SyncSettings() {
  return (
    <div className="col-12">
      <Section id="sync-devices-heading" title="Sync between devices"><DeviceSync /></Section>
      <Section id="backup-file-heading" title="Backup file"><BackupFile /></Section>
      <Section id="old-server-heading" title="Move from an old GoonCave server"><OldServerImport /></Section>
    </div>
  );
}

function DeviceSync() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: api.getSyncSettings });
  const connected = Boolean(settings.data?.url);
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: api.getSyncStatus,
    enabled: connected,
    refetchInterval: (query) => (query.state.data?.state === 'syncing' ? 1000 : 5000)
  });
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!connected) setEditing(false);
  }, [connected]);
  const syncNow = useMutation({
    mutationFn: api.syncNow,
    onSuccess: () => void client.invalidateQueries({ queryKey: STATUS_KEY })
  });
  const disconnect = useMutation({
    mutationFn: api.disconnectSync,
    onSuccess: (value) => {
      client.setQueryData(SETTINGS_KEY, value);
      client.removeQueries({ queryKey: STATUS_KEY });
    }
  });

  if (settings.isPending) {
    return <p className="list-group-item text-muted-foreground text-sm" role="status">Looking for your sync folder…</p>;
  }
  if (settings.isError) {
    return (
      <div className="list-group-item">
        <p className="text-sm">Sync settings could not be loaded: {settings.error.message}</p>
        <button className="btn btn-outline-light btn-sm mt-2" type="button" disabled={settings.isFetching}
          onClick={() => void settings.refetch()}>Load sync settings again</button>
      </div>
    );
  }

  const saved = settings.data;
  const value = status.data;
  const actionError = syncNow.error?.message ?? disconnect.error?.message;

  return (
    <>
      <section className="list-group-item" aria-labelledby="sync-folder-heading">
        <h3 className="font-medium" id="sync-folder-heading">WebDAV folder</h3>
        <p className="text-muted-foreground text-xs mt-1">
          Every device you connect to the same folder shares tags, votes, favorites, read marks, sources and
          settings. Booru passwords and keys stay on each device; grid columns, matching images and automatic
          tagging are set per device. Media files are not copied to the folder.
        </p>
        {!connected || editing ? (
          <ConnectForm key={saved.url ?? 'new'} saved={saved} onDone={connected ? () => setEditing(false) : undefined} />
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="flex-1 min-w-0 text-sm break-all">
              {saved.url}
              {saved.username ? <span className="text-muted-foreground"> · {saved.username}</span> : null}
            </span>
            <button className="btn btn-outline-light btn-sm" type="button" onClick={() => setEditing(true)}>Change folder</button>
            <button className="btn btn-outline-danger btn-sm" type="button" disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}>Disconnect</button>
          </div>
        )}
      </section>

      {connected ? (
        <section className="list-group-item" aria-labelledby="sync-status-heading">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1 min-w-0">
              <h3 className="font-medium" id="sync-status-heading">Status</h3>
              <span className="block text-muted-foreground text-xs" role="status" aria-live="polite">
                {value?.state === 'syncing'
                  ? 'Syncing with the folder…'
                  : value?.state === 'error'
                    ? 'The last sync did not finish. GoonCave tries again every minute.'
                    : value?.lastSyncAt
                      ? `Synced ${when(value.lastSyncAt)}. Changes upload a few seconds after you make them.`
                      : 'Waiting for the first sync.'}
              </span>
            </span>
            <button className="btn btn-outline-light btn-sm shrink-0" type="button"
              disabled={syncNow.isPending || value?.state === 'syncing'} onClick={() => syncNow.mutate()}>
              {value?.state === 'error' ? 'Try again now' : 'Sync now'}
            </button>
          </div>
          {value?.error ? <p className="text-destructive text-sm mt-2 break-words" role="alert">{value.error}</p> : null}
          {status.isError ? (
            <p className="text-destructive text-sm mt-2 break-words" role="alert">
              Sync status could not be read: {status.error.message}
            </p>
          ) : null}
          {actionError ? <p className="text-destructive text-sm mt-2 break-words" role="alert">{actionError}</p> : null}
          <p className="text-muted-foreground text-xs mt-2">
            One backup a day goes to the folder's GoonCave/backups, and the last 14 are kept.
          </p>
        </section>
      ) : null}
    </>
  );
}
