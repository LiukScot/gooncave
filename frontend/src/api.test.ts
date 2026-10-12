import { afterEach, expect, test, vi } from 'vitest';

import { api, extractErrorMessage } from './api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('device startup validates the local profile without a login request', async () => {
  const profile = {
    id: 'device-owner', username: 'device-owner', libraryRoot: '/example/media',
    createdAt: '2026-01-01', updatedAt: '2026-01-01', lastLoginAt: null,
    capabilities: { library: false, boorus: false, processing: false }
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain('/device');
    return new Response(JSON.stringify({ user: profile }));
  });
  vi.stubGlobal('fetch', fetchMock);
  await expect(api.getDeviceProfile()).resolves.toEqual(profile);
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/device');
});

test('device startup surfaces a storage failure instead of treating it as logout', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Check free disk space.' }), { status: 500 })));
  await expect(api.getDeviceProfile()).rejects.toThrow('Check free disk space.');
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

test('extractErrorMessage shows the reason behind an uncaught server error', () => {
  const body = JSON.stringify({
    statusCode: 502,
    error: 'Bad Gateway',
    message: 'rule34.xxx asked for a CAPTCHA'
  });
  expect(extractErrorMessage(body, 'Bad Gateway')).toBe(
    'rule34.xxx asked for a CAPTCHA'
  );
});

test('extractErrorMessage keeps the error a route chose to send', () => {
  expect(
    extractErrorMessage(JSON.stringify({ error: 'Site not found' }), 'Not Found')
  ).toBe('Site not found');
});

test('explorePosts sends an all-time Score request without a date bound', async () => {
  let requestedUrl = '';
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return Promise.resolve(new Response(JSON.stringify({ posts: [], siteErrors: [], sites: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  }));

  await api.explorePosts({
    tags: [], sort: 'popular', window: 'all', page: 1
  });

  const url = new URL(requestedUrl, 'http://localhost');
  expect(url.searchParams.get('window')).toBe('all');
  expect(url.searchParams.has('date')).toBe(false);
});

test('getFileContentBlob reports the server error message, not its JSON body', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ error: 'File not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  );

  await expect(api.getFileContentBlob('file-1')).rejects.toMatchObject({
    message: 'File not found',
    status: 404
  });
});


test('tag vocabulary status validates states and reports a queued retry', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    Response.json(init?.method === 'POST' ? { status: 'queued' } :
      { state: 'failed', importedAt: null, error: 'Check your connection.' })));
  await expect(api.getTagDatabaseStatus()).resolves.toEqual({ state: 'failed', importedAt: null, error: 'Check your connection.' });
  await expect(api.refreshTagDatabase()).resolves.toEqual({ status: 'queued' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ state: 'unknown', importedAt: null, error: null })));
  await expect(api.getTagDatabaseStatus()).rejects.toThrow();
});
