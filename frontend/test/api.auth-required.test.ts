// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, authRequiredEvent } from '../src/api';

/**
 * Pins the auto-logout wiring that the third Playwright spec was guarding.
 *
 * When any authenticated API call returns 401, `handle()` in `src/api.ts`
 * dispatches `gooncave:auth-required` on `window`. The SPA listens for
 * that event and snaps the user back to the login form.
 *
 * If this test breaks, the SPA stays on a half-broken authenticated view
 * after a session expiry — exactly the UX bug #67's e2e suite was meant
 * to catch, now caught at the unit layer with no browser involved.
 */
describe('api 401 → gooncave:auth-required event', () => {
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires the auth-required event when /auth/me returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not authenticated' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );

    await expect(api.getCurrentUser()).rejects.toThrow();

    const events = dispatchSpy.mock.calls
      .map((call) => call[0])
      .filter((event): event is Event => event instanceof Event)
      .map((event) => event.type);
    expect(events).toContain(authRequiredEvent);
  });

  it('does NOT fire the event on non-401 errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    );

    await expect(api.getCurrentUser()).rejects.toThrow();

    const eventTypes = dispatchSpy.mock.calls
      .map((call) => call[0])
      .filter((event): event is Event => event instanceof Event)
      .map((event) => event.type);
    expect(eventTypes).not.toContain(authRequiredEvent);
  });
});
