import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';
import { useErrorToast } from '@/lib/useErrorToast';

const STATUS_POLL_MS = 5000;

export function TagDatabaseStatus() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.tagDatabase,
    queryFn: api.getTagDatabaseStatus,
    refetchInterval: STATUS_POLL_MS
  });
  const refresh = useMutation({
    mutationFn: api.refreshTagDatabase,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tagDatabase })
  });
  const busy = refresh.isPending || status.data?.state === 'queued' || status.data?.state === 'running';
  useErrorToast(refresh.error?.message ?? status.error?.message);
  useErrorToast(status.data?.error, undefined, { onlyOnline: true });

  return (
    <section className="mt-4" aria-labelledby="tag-database-heading">
      <h3 className="font-medium mb-2" id="tag-database-heading">Tag vocabulary</h3>
      <p className="text-muted-foreground text-sm mb-2">
        Aliases and broader tags come from e621 and Danbooru. The vocabulary
        updates weekly after you add tags. Files stay on your device; Danbooru
        receives tag names it needs to categorise.
      </p>
      <p className="text-muted-foreground text-sm mb-2" role="status">
        {busy ? 'Downloading tag vocabulary. Your library stays available.' :
          status.data?.importedAt ? 'Saved vocabulary available for alias and broader-tag searches.' :
          status.isPending ? 'Checking tag vocabulary…' :
          status.isError ? 'The saved vocabulary status could not be checked.' : 'Vocabulary not downloaded yet. Search still matches your saved tag names.'}
      </p>
      <button className="btn btn-outline-light btn-sm" type="button" disabled={busy}
        onClick={() => {
          if (status.isError) { void status.refetch(); }
          else { refresh.mutate(); }
        }}>
        {busy ? 'Downloading…' : status.isError ? 'Check vocabulary again' : 'Download tag vocabulary'}
      </button>
    </section>
  );
}
