import { describe, expect, it } from 'vitest';

import { settingsSlideDirection } from './settingsSlide';

const at = (pathname: string) => ({ pathname });

describe('settingsSlideDirection', () => {
  it('pushes into a Settings page and pops back out', () => {
    expect(
      settingsSlideDirection(at('/app/settings'), at('/app/settings/appearance'))
    ).toBe('push');
    expect(
      settingsSlideDirection(at('/app/settings/appearance'), at('/app/settings'))
    ).toBe('pop');
    expect(
      settingsSlideDirection(at('/app/settings/extra'), at('/app/settings/blacklist'))
    ).toBeNull();
  });

  it('changes page at once between the views of the menu and on the first load', () => {
    expect(settingsSlideDirection(at('/app/gallery'), at('/app/explore'))).toBeNull();
    expect(settingsSlideDirection(at('/app/settings'), at('/app/gallery'))).toBeNull();
    expect(settingsSlideDirection(at('/app/gallery'), at('/app/settings'))).toBeNull();
    expect(settingsSlideDirection(undefined, at('/app/settings'))).toBeNull();
  });
});
