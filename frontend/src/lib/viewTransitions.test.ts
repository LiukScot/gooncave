import { describe, expect, it } from 'vitest';

import { tabTransitionTypes } from './viewTransitions';

const at = (pathname: string, search: object = {}) => ({ pathname, search });

describe('tabTransitionTypes', () => {
  it('slides forward going down the menu and back going up, for every pair of views', () => {
    const menu = [
      at('/app/explore'),
      at('/app/gallery'),
      at('/app/explore', { feed: 'subscribed' }),
      at('/app/explore', { feed: 'history' }),
      at('/app/settings')
    ];
    menu.forEach((from, fromIndex) =>
      menu.forEach((to, toIndex) => {
        if (fromIndex === toIndex) return;
        expect(tabTransitionTypes(from, to)).toEqual([
          toIndex > fromIndex ? 'tab-forward' : 'tab-back'
        ]);
      })
    );
  });

  it('places a Settings page where Settings sits in the menu', () => {
    expect(
      tabTransitionTypes(at('/app/settings/subscriptions'), at('/app/explore', { feed: 'subscribed' }))
    ).toEqual(['tab-back']);
  });

  it('does not slide within a view or on the first load', () => {
    expect(tabTransitionTypes(at('/app/gallery'), at('/app/gallery'))).toBe(
      false
    );
    expect(tabTransitionTypes(undefined, at('/app/gallery'))).toBe(false);
  });

  it('does not slide when a detail view is open on either side', () => {
    const file = at('/app/gallery', { fileId: 'f1' });
    const post = at('/app/explore', { post: 'site:1' });
    expect(tabTransitionTypes(file, post)).toBe(false);
    expect(tabTransitionTypes(post, file)).toBe(false);
    expect(tabTransitionTypes(file, at('/app/explore'))).toBe(false);
  });

  it('pushes into a Settings page and pops back out', () => {
    expect(
      tabTransitionTypes(at('/app/settings'), at('/app/settings/appearance'))
    ).toEqual(['push']);
    expect(
      tabTransitionTypes(at('/app/settings/appearance'), at('/app/settings'))
    ).toEqual(['pop']);
    expect(
      tabTransitionTypes(at('/app/settings/extra'), at('/app/settings/blacklist'))
    ).toBe(false);
  });
});
