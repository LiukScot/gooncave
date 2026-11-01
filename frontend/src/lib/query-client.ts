import { QueryClient } from '@tanstack/react-query';

/** fetch() rejects with a TypeError when nothing answers, never for an HTTP status. */
const isNetworkError = (error: unknown) => error instanceof TypeError;

// On iPhone the library's server restarts after the app returns from the
// background, which takes several seconds; these retries span that gap.
const NETWORK_RETRIES = 4;
const MAX_RETRY_DELAY_MS = 8_000;

export const shouldRetryQuery = (failures: number, error: unknown) =>
  failures < (isNetworkError(error) ? NETWORK_RETRIES : 1);

export const queryRetryDelay = (failures: number) =>
  Math.min(1_000 * 2 ** failures, MAX_RETRY_DELAY_MS);

export function createQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // Requests go to the core on this device; the default would pause them all offline.
        networkMode: 'always',
        refetchOnReconnect: true,
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        refetchOnWindowFocus: false
      },
      mutations: {
        networkMode: 'always',
        retry: 0
      }
    }
  });
  // A query that gave up while the app was away tries again on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    void client.refetchQueries({ type: 'active', predicate: (query) => query.state.status === 'error' });
  });
  return client;
}
