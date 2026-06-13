import { mock } from 'bun:test';
// Resolved before the mock.module call below runs, so it captures the real
// undici exports (fetch for passthrough, plus everything else this module
// re-exports unchanged).
import * as undiciReal from 'undici';

// bun replaces undici's MockAgent with a non-functional stub, so HTTP-mocking
// tests cannot use setGlobalDispatcher. Instead the engines' `fetch` import is
// swapped for a router that replays per-test canned responses. When no routes
// are armed the router delegates to the real fetch, so this module stays inert
// for the rest of the suite even though the mock is installed process-wide.

export type FetchMockReply = {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  // A persistent route keeps matching every request instead of being consumed
  // once, mirroring undici MockAgent's .persist().
  persist?: boolean;
};

export type FetchUrlMatcher = (url: string, init?: RequestInit) => boolean;

type Route = { matcher: FetchUrlMatcher; reply: FetchMockReply; used: boolean };

let routes: Route[] | null = null;
const realFetch = (undiciReal as unknown as { fetch: typeof fetch }).fetch;

const toUrl = (input: unknown): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
};

const mockedFetch = async (
  input: unknown,
  init?: RequestInit
): Promise<Response> => {
  if (!routes) {
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }
  const url = toUrl(input);
  const route = routes.find((entry) => !entry.used && entry.matcher(url, init));
  if (!route) {
    throw new Error(
      `No fetch mock registered for ${init?.method ?? 'GET'} ${url}`
    );
  }
  if (!route.reply.persist) {
    route.used = true;
  }
  return new Response(route.reply.body ?? '', {
    status: route.reply.status,
    headers: route.reply.headers
  });
};

mock.module('undici', () => ({ ...undiciReal, fetch: mockedFetch }));

export type FetchMock = {
  intercept: (matcher: FetchUrlMatcher, reply: FetchMockReply) => void;
};

export const armFetchMock = (): FetchMock => {
  routes = [];
  return {
    intercept: (matcher, reply) => {
      routes!.push({ matcher, reply, used: false });
    }
  };
};

export const disarmFetchMock = (): void => {
  routes = null;
};

// Callers register `afterEach(disarmFetchMock)` at file scope so the router
// goes inert between tests (bun:test has no per-test `t.after` context).
export const setupFetchMock = (): FetchMock => armFetchMock();
