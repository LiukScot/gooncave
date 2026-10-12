import { argbFromHex, Hct } from '@material/material-color-utilities';
import { expect, it } from 'vitest';

import { ACCENT_IDS, TINT_ACCENTS, accentLabel, appleAccent } from './accents';

it('offers the two basics, then 12 tints from red to purple', () => {
  expect(ACCENT_IDS.slice(0, 2)).toEqual(['mono', 'blue']);
  expect(TINT_ACCENTS).toHaveLength(12);
  expect(accentLabel(TINT_ACCENTS[0])).toMatch(/^Pastel red/);
  expect(accentLabel(TINT_ACCENTS[11])).toMatch(/^Pastel purple/);
});

it('lets an open picture override the chosen accent in Apple Edition', () => {
  const green = argbFromHex('#2e9e4a');
  const fromPicture = Hct.fromInt(appleAccent('mono', true, green));
  expect(Math.abs(fromPicture.hue - Hct.fromInt(green).hue)).toBeLessThan(5);
  expect(appleAccent('mono', true)).toBe(argbFromHex('#ffffff'));
});
