// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { issueAddress, ReportIssueSettings, reportBody, reportHead } from './ReportIssueSettings';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
});

const device = { version: '1.3.0', commit: 'abc1234', platform: 'ios aarch64', schema: '0042_tags', jobs: ['Device sync: idle'] };
const bodyOf = (href: string) => new URL(href).searchParams.get('body');

const render = async () => {
  const container = document.createElement('div');
  root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <ReportIssueSettings />
      </QueryClientProvider>
    )
  );
  for (let attempt = 0; attempt < 20 && container.textContent?.includes('Reading the log'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return container;
};

it('sends a short report whole', () => {
  const head = reportHead({ ...device, log: '' }, 'It froze');
  const issue = issueAddress(head, 'first line\nsecond line');
  expect(bodyOf(issue.href)).toBe(reportBody(head, ['first line', 'second line']));
  expect(bodyOf(issue.href)).toContain('It froze');
  expect(issue.removedLines).toBe(0);
});

it('leaves out the oldest log lines first when the report is too long', () => {
  const log = Array.from({ length: 200 }, (_, line) => `line ${line} ${'x'.repeat(100)}`).join('\n');
  const issue = issueAddress(reportHead({ ...device, log }, ''), log);
  const body = bodyOf(issue.href) ?? '';
  expect(issue.href.length).toBeLessThanOrEqual(7500);
  // No more lines go than needed: one more kept line would not fit.
  expect(issue.href.length).toBeGreaterThan(7500 - 150);
  expect(issue.removedLines).toBeGreaterThan(0);
  expect(body).toContain(`(${issue.removedLines} older lines left out)`);
  expect(body).toContain('line 199 ');
  expect(body).not.toContain('line 0 ');
  expect(body).toContain('App version: 1.3.0 (abc1234)');
});

it('opens an empty issue when the text above the log does not fit', () => {
  const issue = issueAddress('y'.repeat(20000), 'one line');
  expect(issue.bodyFits).toBe(false);
  expect(bodyOf(issue.href)).toBeNull();
});

it('shows device, work and log read-only, and only the description is typed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...device, log: 'Cannot read a note' })));
  const container = await render();
  const fields = container.querySelectorAll('textarea, input');
  expect(fields).toHaveLength(1);
  const description = container.querySelector('textarea');
  expect(description?.value).toBe('');
  expect(container.querySelector('pre')?.textContent).toBe('Cannot read a note');
  expect(container.textContent).toContain('ios aarch64');
  expect(container.textContent).toContain('Device sync: idle');
  expect(container.textContent).toContain(navigator.userAgent);
  expect(container.textContent).toMatch(/\d+×\d+ at [\d.]+x, (no )?touch/);

  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(description, 'The gallery froze');
    description?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const link = container.querySelector<HTMLAnchorElement>('a[target="_blank"]');
  expect(description?.nextElementSibling).toBe(link);
  const body = bodyOf(link?.href ?? '') ?? '';
  expect(body).toContain('## What happened\n\nThe gallery froze');
  expect(body).toContain('Cannot read a note');
  expect(body).toContain(`System: ${navigator.userAgent}`);
});

it('says what failed and offers a retry and an empty issue when the log cannot be read', async () => {
  let failed = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      failed
        ? Response.json({ error: 'Check free disk space.' }, { status: 500 })
        : Response.json({ ...device, log: 'recovered' })
    )
  );
  const container = await render();
  expect(container.textContent).toContain('Check free disk space.');
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.querySelector('a[target="_blank"]')?.textContent).toContain('empty GitHub issue');

  failed = false;
  await act(async () => container.querySelector('button')?.click());
  for (let attempt = 0; attempt < 20 && !container.querySelector('pre'); attempt += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  expect(container.querySelector('pre')?.textContent).toBe('recovered');
});
