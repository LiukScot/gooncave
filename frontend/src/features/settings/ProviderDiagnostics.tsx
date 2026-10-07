import { useQuery } from '@tanstack/react-query';

import { api } from '@/api';

const operations = {
  search: 'Search',
  detail: 'Post details',
  favorite: 'Favorites',
  'provider-action': 'Provider action'
};
const outcomes = {
  pending: 'Still waiting when captured',
  completed: 'Request finished',
  failed: 'Request failed',
  cancelled: 'Request cancelled'
};

export function ProviderDiagnostics() {
  const reports = useQuery({
    queryKey: ['settings', 'provider-diagnostics'],
    queryFn: api.getProviderDiagnostics,
    retry: false
  });
  return (
    <section
      className="settings-section mt-4"
      aria-labelledby="provider-reports-heading"
    >
      <h2 id="provider-reports-heading" className="text-lg font-medium">
        Provider reports
      </h2>
      <p className="text-muted-foreground text-sm mb-3">
        Slow requests, errors and retries are recorded automatically on this
        server. Reports exclude credentials, searches and post contents. They
        expire after 7 days.
      </p>
      <button
        type="button"
        className="btn btn-outline-light btn-sm mb-3"
        disabled={reports.isFetching}
        onClick={() => {
          void reports.refetch();
        }}
      >
        {reports.isFetching ? 'Loading reports…' : 'Refresh reports'}
      </button>
      {reports.isError ? (
        <p role="alert" className="text-destructive text-sm">
          Reports could not be loaded. {(reports.error as Error).message} Use
          Refresh reports to try again.
        </p>
      ) : null}
      {!reports.isPending && !reports.isError && !reports.data?.length ? (
        <p className="text-muted-foreground text-sm">
          No provider incidents recorded for your account in the last 7 days.
        </p>
      ) : null}
      <div className="list-group">
        {reports.data?.map((report) => (
          <details key={report.id} className="list-group-item">
            <summary className="cursor-pointer">
              <span className="font-medium">
                {operations[report.operation]} · {report.providers.join(', ')}
              </span>
              <span className="block text-muted-foreground text-xs mt-1">
                {new Date(report.updatedAt).toLocaleString(undefined, {
                  timeZoneName: 'short'
                })}{' '}
                · {outcomes[report.outcome]} · {report.count} occurrence
                {report.count === 1 ? '' : 's'}
              </span>
            </summary>
            <p className="text-sm mt-3">
              Total: {(report.elapsedMs / 1000).toFixed(1)} s · Shared retry
              wait: {(report.sharedWaitMs / 1000).toFixed(1)} s
            </p>
            <p className="text-sm">
              Requests: {report.requestCount} · Retries: {report.retries} ·
              CAPTCHA: {report.challenges} · Rate limits: {report.rateLimits}
            </p>
            <p className="text-muted-foreground text-xs mt-2">
              Latest {report.attempts.length} requests; grouped reports show the
              latest occurrence.
            </p>
            <ol className="text-sm list-decimal pl-5">
              {report.attempts.map((attempt, index) => (
                <li key={index}>
                  {attempt.provider}:{' '}
                  {attempt.outcome === 'pending'
                    ? 'Waiting for a response'
                    : attempt.outcome === 'network-error'
                      ? 'Connection failed'
                      : `HTTP ${attempt.status}`}{' '}
                  · {(attempt.elapsedMs / 1000).toFixed(1)} s
                </li>
              ))}
            </ol>
          </details>
        ))}
      </div>
    </section>
  );
}
