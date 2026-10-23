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

it('keeps tag refresh visible but disabled when the core cannot run it', async () => {
  const site = { id: 'site', name: 'Site', engine: 'danbooru', username: null,
    hasApiKey: false, hasSessionCookie: false, engineSupportsSessionCookie: false } as BooruSite;
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(<BooruSiteCredentialForm site={site} schema="username+apikey"
      loading={false} testing={false} tagRefreshAvailable={false}
      onSave={vi.fn(async () => site)} onTest={vi.fn()} onClearTags={vi.fn()} onDelete={vi.fn()} />);
  });
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Re-fetch tags');
  expect(button?.disabled).toBe(true);
  expect(button?.title).toContain('not available');
});

it('replaces FurAffinity cookie fields with sign-in where the app can open its window', async () => {
  const site = { id: 'site', name: 'FurAffinity', engine: 'furaffinity', username: null,
    hasApiKey: false, hasSessionCookie: false, engineSupportsSessionCookie: true } as BooruSite;
  const onSignIn = vi.fn(async () => undefined);
  const container = document.createElement('div');
  root = createRoot(container);
  const render = (signIn?: () => Promise<void>) =>
    act(async () => {
      root?.render(<BooruSiteCredentialForm site={site} schema="username+session-cookie"
        loading={false} testing={false} onSignIn={signIn}
        onSave={vi.fn(async () => site)} onTest={vi.fn()} onClearTags={vi.fn()} onDelete={vi.fn()} />);
    });
  const signInButton = () => Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent?.trim() === 'Sign in to FurAffinity');

  await render();
  expect(signInButton()).toBeUndefined();
  expect(container.querySelector('input[type="password"]')).not.toBeNull();

  await render(onSignIn);
  expect(container.querySelector('input')).toBeNull();
  expect(container.textContent).not.toContain('Save credentials');
  expect(container.textContent).toContain('Not signed in');
  await act(async () => signInButton()?.click());
  expect(onSignIn).toHaveBeenCalledOnce();
});

it('signs in to Rule34 in place of its cookie field and explains where the API key is', async () => {
  const site = { id: 'site', name: 'Rule34', engine: 'gelbooru', username: null,
    hasApiKey: false, hasSessionCookie: false, engineSupportsSessionCookie: true,
    browserSignIn: 'Rule34' } as BooruSite;
  const onSignIn = vi.fn(async () => undefined);
  const container = document.createElement('div');
  root = createRoot(container);
  const render = (signIn?: () => Promise<void>) =>
    act(async () => {
      root?.render(<BooruSiteCredentialForm site={site} schema="userid+apikey"
        loading={false} testing={false} onSignIn={signIn}
        onSave={vi.fn(async () => site)} onTest={vi.fn()} onClearTags={vi.fn()} onDelete={vi.fn()} />);
    });
  const signInButton = () => Array.from(container.querySelectorAll('button'))
    .find(button => button.textContent?.trim() === 'Sign in to Rule34');

  await render();
  expect(signInButton()).toBeUndefined();
  expect(container.textContent).toContain('Session cookie');

  await render(onSignIn);
  expect(container.textContent).not.toContain('Session cookie');
  expect(container.querySelector('#site-site-username')).not.toBeNull();
  expect(container.querySelector('#site-site-api-key')).not.toBeNull();
  expect(container.querySelector('[aria-label*="API Access Credentials"]')).not.toBeNull();
  await act(async () => signInButton()?.click());
  expect(onSignIn).toHaveBeenCalledOnce();
});
