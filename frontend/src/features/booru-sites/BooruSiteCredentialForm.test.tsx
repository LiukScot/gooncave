// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { BooruSiteCredentialForm } from './BooruSiteCredentialForm';

import type { BooruSite } from '@/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it('tests credentials immediately after a successful save', async () => {
  const onTest = vi.fn(async () => undefined);
  const site = {
    id: 'site',
    name: 'Site',
    engine: 'danbooru',
    username: 'demo',
    hasApiKey: false,
    hasSessionCookie: false,
    engineSupportsSessionCookie: false
  } as BooruSite;
  const onSave = vi.fn(async () => site);
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <BooruSiteCredentialForm
        site={site}
        schema="username+apikey"
        loading={false}
        testing={false}
        onSave={onSave}
        onTest={onTest}
        onClearTags={vi.fn()}
        onDelete={vi.fn()}
      />
    );
  });

  await act(async () => {
    container.querySelector('form')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
  });

  expect(onSave).toHaveBeenCalledOnce();
  expect(onTest).toHaveBeenCalledOnce();
});

it('keeps mobile credential help outside the input label', async () => {
  const site = {
    id: 'site',
    name: 'Site',
    engine: 'gelbooru',
    username: null,
    hasApiKey: false,
    hasSessionCookie: false,
    engineSupportsSessionCookie: true
  } as BooruSite;
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <BooruSiteCredentialForm
        site={site}
        schema="none"
        loading={false}
        testing={false}
        onSave={vi.fn(async () => site)}
        onTest={vi.fn()}
        onClearTags={vi.fn()}
        onDelete={vi.fn()}
      />
    );
  });

  expect(
    container.querySelector('label[for] .favorites-help-mobile')
  ).toBeNull();
  expect(container.querySelector('.favorites-help-mobile')).toBeInstanceOf(
    HTMLButtonElement
  );
});
