import { expect, it } from 'vitest';

import { ACCENT_IDS, TINT_ACCENTS, accentLabel } from './accents';

it('offers the two basics, then 12 tints from red to purple', () => {
  expect(ACCENT_IDS.slice(0, 2)).toEqual(['mono', 'blue']);
  expect(TINT_ACCENTS).toHaveLength(12);
  expect(accentLabel(TINT_ACCENTS[0])).toMatch(/^Pastel red/);
  expect(accentLabel(TINT_ACCENTS[11])).toMatch(/^Pastel purple/);
});
