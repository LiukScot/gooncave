import { expect, it } from 'vitest';

import { ACCENT_IDS, DEFAULT_ACCENT, accentLabel } from './accents';

it('goes round the colour wheel from the default, with blue among the tints', () => {
  expect(ACCENT_IDS[0]).toBe(DEFAULT_ACCENT);
  expect(ACCENT_IDS).toHaveLength(13);
  expect(accentLabel(ACCENT_IDS[0])).toBe('Pastel orange (1 of 13)');
  expect(accentLabel(ACCENT_IDS[1])).toMatch(/^Pastel yellow/);
  expect(accentLabel(ACCENT_IDS[12])).toMatch(/^Pastel orange/);
  expect(accentLabel(ACCENT_IDS[11])).toMatch(/^Pastel red/);
  const blue = ACCENT_IDS.indexOf('blue');
  expect(accentLabel(ACCENT_IDS[blue - 1])).toMatch(/^Pastel (cyan|blue)/);
  expect(accentLabel(ACCENT_IDS[blue + 1])).toMatch(/^Pastel (blue|violet)/);
});
