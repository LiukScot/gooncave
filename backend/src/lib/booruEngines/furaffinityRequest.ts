import { fetch as undiciFetch } from 'undici';

import { config } from '../../config';
import type { BooruSiteRecord } from '../../db/types';

import {
  parseSubmissionPage,
  type FurAffinitySubmissionPage
} from './furaffinityHtml';

const REQUEST_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [2_000, 4_000] as const;
const RETRYABLE_STATUS = new Set([
  429, 500, 502, 503, 504, 520, 521, 522, 523, 524
]);

type Wait = (ms: number, signal?: AbortSignal) => Promise<void>;

export type FurAffinityRequestOptions = {
  fetchImpl?: typeof undiciFetch;
  minRequestIntervalMs?: number;
  requestTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  wait?: Wait;
};

const abortError = () => new Error('FurAffinity request aborted');

const abortableWait: Wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const headersFor = (
  site: BooruSiteRecord,
  authenticated: boolean
): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': config.e621.userAgent,
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (authenticated && site.sessionCookie) headers.Cookie = site.sessionCookie;
  return headers;
};

export const requireFurAffinityCredentials = (
  site: BooruSiteRecord
): void => {
  if (!site.username || !site.sessionCookie) {
    throw new Error(
      `${site.name} needs a username and session cookie under Settings → Favorites accounts`
    );
  }
};

export const safeFurAffinityError = (
  site: BooruSiteRecord,
  error: unknown
): string => {
  let message = error instanceof Error ? error.message : String(error);
  if (site.sessionCookie) {
    message = message.split(site.sessionCookie).join('[redacted cookie]');
  }
  return message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]');
};

export const createFurAffinityRequester = (
  origin: string,
  options: FurAffinityRequestOptions
) => {
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const minRequestIntervalMs =
    options.minRequestIntervalMs ?? REQUEST_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? abortableWait;
  let requestQueue = Promise.resolve();
  let nextRequestAt = 0;
  const submissionReads = new Map<
    string,
    { promise: Promise<FurAffinitySubmissionPage>; owner: object }
  >();

  const schedule = async <T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> => {
    const previous = requestQueue;
    let release = () => {};
    requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (signal?.aborted) throw abortError();
      const delay = Math.max(0, nextRequestAt - now());
      if (delay > 0) await wait(delay, signal);
      if (signal?.aborted) throw abortError();
      nextRequestAt = now() + minRequestIntervalMs;
      return await operation();
    } finally {
      release();
    }
  };

  type RequestOptions = {
    authenticated?: boolean;
    signal?: AbortSignal;
    allowRedirect?: boolean;
  };

  const fetchAttempt = async (
    site: BooruSiteRecord,
    path: string,
    requestOptions: RequestOptions
  ) =>
    schedule(async () => {
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
      const combinedSignal = requestOptions.signal
        ? AbortSignal.any([requestOptions.signal, timeoutSignal])
        : timeoutSignal;
      const fetched = await fetchImpl(new URL(path, origin), {
        headers: headersFor(site, requestOptions.authenticated ?? true),
        redirect: requestOptions.allowRedirect ? 'manual' : 'follow',
        signal: combinedSignal
      });
      return {
        status: fetched.status,
        ok: fetched.ok,
        body: await fetched.text()
      };
    }, requestOptions.signal);

  const request = async (
    site: BooruSiteRecord,
    path: string,
    requestOptions: RequestOptions = {}
  ): Promise<{ status: number; body: string }> => {
    const { signal } = requestOptions;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw abortError();
      let response: { status: number; body: string; ok: boolean };
      try {
        response = await fetchAttempt(site, path, requestOptions);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (attempt >= retryDelaysMs.length) {
          const reason = safeFurAffinityError(site, error);
          const message = `${site.name} request failed after retries: ${reason}`;
          if (error instanceof Error) {
            error.message = message;
            error.stack = undefined;
            throw error;
          }
          throw new Error(message, { cause: error });
        }
        await wait(retryDelaysMs[attempt], signal);
        continue;
      }

      const redirectAccepted =
        requestOptions.allowRedirect &&
        response.status >= 300 &&
        response.status < 400;
      if (response.ok || redirectAccepted) {
        return { status: response.status, body: response.body };
      }
      if (
        RETRYABLE_STATUS.has(response.status) &&
        attempt < retryDelaysMs.length
      ) {
        await wait(retryDelaysMs[attempt], signal);
        continue;
      }
      throw new Error(`${site.name} request failed (${response.status})`);
    }
  };

  const readSubmission = async (
    site: BooruSiteRecord,
    postId: string,
    signal?: AbortSignal
  ): Promise<FurAffinitySubmissionPage> => {
    const fetchSubmission = async () => {
      const response = await request(site, `/view/${postId}/`, { signal });
      return parseSubmissionPage(response.body, postId);
    };
    if (signal) return fetchSubmission();
    const key = `${site.id}:${postId}`;
    const inFlight = submissionReads.get(key);
    if (inFlight) return inFlight.promise;
    const owner = {};
    const pending = fetchSubmission();
    submissionReads.set(key, { promise: pending, owner });
    try {
      return await pending;
    } finally {
      if (submissionReads.get(key)?.owner === owner) submissionReads.delete(key);
    }
  };

  return { request, readSubmission, abortError };
};
