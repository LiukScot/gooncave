import { describe, expect, it } from 'vitest';

import { settingsTransitionTypes } from './viewTransitions';

const at = (pathname: string) => ({ pathname });

describe('settingsTransitionTypes', () => {
  it('pushes into a Settings page and pops back out', () => {
    expect(
      settingsTransitionTypes(at('/app/settings'), at('/app/settings/appearance'))
    ).toEqual(['push']);
    expect(
      settingsTransitionTypes(at('/app/settings/appearance'), at('/app/settings'))
    ).toEqual(['pop']);
    expect(
      settingsTransitionTypes(at('/app/settings/extra'), at('/app/settings/blacklist'))
    ).toBe(false);
  });

  it('changes page at once between the views of the menu and on the first load', () => {
    expect(settingsTransitionTypes(at('/app/gallery'), at('/app/explore'))).toBe(false);
    expect(settingsTransitionTypes(at('/app/settings'), at('/app/gallery'))).toBe(false);
    expect(settingsTransitionTypes(at('/app/gallery'), at('/app/settings'))).toBe(false);
    expect(settingsTransitionTypes(undefined, at('/app/settings'))).toBe(false);
  });
});
