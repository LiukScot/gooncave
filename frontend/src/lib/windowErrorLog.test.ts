import { afterEach, expect, it, vi } from 'vitest';

import { installWindowErrorLog } from './windowErrorLog';

afterEach(() => vi.unstubAllGlobals());

const install = () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  const target = new EventTarget();
  installWindowErrorLog(target as unknown as Pick<Window, 'addEventListener'>);
  return {
    error: (message: string) => target.dispatchEvent(Object.assign(new Event('error'), { message })),
    rejection: (reason: unknown) =>
      target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason })),
    sent: () =>
      fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { message: string }).message)
  };
};

it('sends each message once, even when two errors come in turn', () => {
  const page = install();
  for (const message of ['first', 'second', 'first', 'second']) page.error(message);
  expect(page.sent()).toEqual(['first', 'second']);
});

it('sends the reason of a rejected promise and skips an error without a message', () => {
  const page = install();
  page.error('');
  page.rejection(new Error('from an error'));
  page.rejection('from a string');
  expect(page.sent()).toEqual(['from an error', 'from a string']);
});

it('stops sending after 50 different messages', () => {
  const page = install();
  for (let index = 0; index < 60; index += 1) page.error(`message ${index}`);
  expect(page.sent()).toHaveLength(50);
});
