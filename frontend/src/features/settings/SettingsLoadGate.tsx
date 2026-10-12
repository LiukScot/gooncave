import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { api } from '@/api';
import { queryKeys } from '@/lib/query-keys';

const readers = {
  extra: api.getExtraSettings,
  blacklist: api.getBlacklist,
  shortcuts: api.getShortcuts
};

export function SettingsLoadGate({ section, children }: {
  section: keyof typeof readers;
  children: ReactNode;
}) {
  const query = useQuery({
    queryKey: queryKeys.settings[section](),
    queryFn: (): Promise<unknown> => readers[section](),
    staleTime: 60_000,
    retry: false
  });
  if (query.isPending) return <p role="status">Loading settings…</p>;
  return <>
    {query.isError ? <div>
      <p role="alert">Settings could not be loaded. {query.error.message}</p>
      <button className="btn btn-primary" type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>Load settings again</button>
    </div> : null}
    {query.data !== undefined ? children : null}
  </>;
}
