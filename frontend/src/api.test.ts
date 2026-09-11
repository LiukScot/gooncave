import { afterEach, expect, test, vi } from 'vitest';

import { api } from './api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('refreshFileTags follows the queued job until fresh tags are available', async () => {
  vi.useFakeTimers();
  const responses = [
    new Response(
      JSON.stringify({
        status: 'queued',
        job: { id: 'job-1', fileId: 'file-1', status: 'queued', error: null }
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    ),
    new Response(
      JSON.stringify({
        job: { id: 'job-1', fileId: 'file-1', status: 'done', error: null }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ),
    new Response(JSON.stringify({ tags: [], implied: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  ];
  const requestedUrls: string[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return Promise.resolve(responses.shift()!);
  });
  vi.stubGlobal('fetch', fetchMock);

  const resultPromise = api.refreshFileTags('file-1');
  await vi.advanceTimersByTimeAsync(500);
  await expect(resultPromise).resolves.toEqual({ tags: [], implied: [] });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(requestedUrls[1]).toContain('/files/file-1/tags/refresh/job-1');
});

test('refreshFileTags surfaces a background job failure', async () => {
  vi.useFakeTimers();
  const responses = [
    new Response(
      JSON.stringify({
        job: { id: 'job-2', fileId: 'file-2', status: 'running', error: null }
      }),
      { status: 202, headers: { 'Content-Type': 'application/json' } }
    ),
    new Response(
      JSON.stringify({
        job: {
          id: 'job-2',
          fileId: 'file-2',
          status: 'error',
          error: 'Tag refresh failed'
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(responses.shift()!))
  );

  const resultPromise = api.refreshFileTags('file-2');
  const rejected = expect(resultPromise).rejects.toThrow('Tag refresh failed');
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
});
