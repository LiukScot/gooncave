import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { api } from '@/api';

const STATUS_KEY = ['tagging'] as const;
const bytes = (value: number) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 1_000_000)} MB`;

export function AutomaticTagging() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: api.getTaggingStatus, refetchInterval: 2000 });
  const toggle = useMutation({
    mutationFn: api.setTaggingEnabled,
    onSuccess: (value) => client.setQueryData(STATUS_KEY, value)
  });
  const value = status.data;
  const error = toggle.error?.message ?? status.error?.message ?? value?.error;
  const busy = value?.state === 'downloading' || value?.state === 'loading' || value?.state === 'starting';

  return (
    <section className="list-group-item" aria-labelledby="automatic-tagging-heading">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 min-w-0">
          <h3 className="font-medium" id="automatic-tagging-heading">Automatic tagging (WD14)</h3>
          <span className="block text-muted-foreground text-xs">
            {value ? `Optional ${bytes(value.modelBytes)} model. Downloads when enabled; saved downloads are reused. Images stay on this device.` : 'Checking the optional model download…'}
          </span>
        </span>
        {value?.available ? (
          <button className="btn btn-outline-light btn-sm shrink-0" type="button" disabled={toggle.isPending}
            onClick={() => toggle.mutate(!value.enabled)}>
            {value.enabled ? 'Stop tagging' : 'Enable tagging'}
          </button>
        ) : status.isError ? (
          <button className="btn btn-outline-light btn-sm" type="button" disabled={status.isFetching}
            onClick={() => { void status.refetch(); }}>Check tagging again</button>
        ) : null}
      </div>
      {value && !value.available ? (
        <p className="text-muted-foreground text-sm mt-2">
          This device cannot run the tagging model yet. <Link to="/app/gallery" search={{ fileId: undefined, fs: undefined }}>Open Gallery to add tags by hand</Link>.
        </p>
      ) : value ? (
        <div className="text-muted-foreground text-xs mt-2" role="status" aria-live="polite">
          {value.state === 'downloading' ? `Downloading model: ${bytes(value.downloadedBytes)} of ${bytes(value.modelBytes)}.` :
            value.state === 'loading' ? 'Loading model. Your library stays available.' :
            value.state === 'starting' ? 'Starting automatic tagging…' :
            value.enabled ? `${value.completed} of ${value.total} files tagged. ${value.state === 'ready' ? 'Waiting for new files.' : ''}` : 'Automatic tagging is off. Existing tags are kept.'}
          {value.failed > 0 ? ` ${value.failed} files could not be tagged. Turn tagging off and on to retry.` : null}
          {value.enabled && busy ? (
            <progress className="progress mt-2" aria-label="Model download" max={value.modelBytes} value={value.downloadedBytes} />
          ) : value.enabled && value.total > 0 ? (
            <progress className="progress mt-2" aria-label="Files tagged" max={value.total} value={value.completed} />
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-destructive text-sm mt-2 break-words" role="alert">{error}</p> : null}
    </section>
  );
}
