import { QueryClient } from '@tanstack/react-query';
import { expect, it } from 'vitest';

import { clearSignedOutQueries } from './auth';

import { queryKeys } from '@/lib/query-keys';

it('forgets every cached query of the signed-out user but keeps auth observable', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.auth.me(), { id: 'user-a' });
  queryClient.setQueryData(queryKeys.settings.blacklist(), { tags: ['x'] });
  queryClient.setQueryData(['settings', 'provider-diagnostics'], []);
  queryClient.setQueryData(queryKeys.explorePostText('site', '1'), {});
  queryClient.setQueryData(queryKeys.files.all, []);

  clearSignedOutQueries(queryClient);

  expect(queryClient.getQueryData(queryKeys.auth.me())).toBeNull();
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey)
  ).toEqual([queryKeys.auth.me()]);
});
