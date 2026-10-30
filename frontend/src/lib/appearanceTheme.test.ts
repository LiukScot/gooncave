// @vitest-environment happy-dom

import { Hct } from '@material/material-color-utilities';
import { describe, expect, it } from 'vitest';

import { ACCENT_IDS } from './accents';
import { ACCENT_TOKEN_ROLES, accentScheme } from './appearanceTheme';

const luminance = (argb: number): number => {
  const { r, g, b } = { r: (argb >> 16) & 255, g: (argb >> 8) & 255, b: argb & 255 };
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: number, b: number): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const grey = (percent: number): number => {
  const v = Math.round((percent / 100) * 255);
  return (255 << 24) | (v << 16) | (v << 8) | v;
};

// The surfaces text and controls sit on, from index.css.
const SURFACES = {
  dark: [0, 10, 12, 14, 18],
  light: [96, 100, 91]
};

describe.each(['dark', 'light'] as const)('every accent in %s', (mode) => {
  const dark = mode === 'dark';
  it.each(ACCENT_IDS)('%s keeps its text and links readable', (accent) => {
    const scheme = accentScheme(accent, dark);
    // Text on a button filled with the accent.
    expect(contrast(scheme.primary, scheme.onPrimary)).toBeGreaterThanOrEqual(4.5);
    // Link text and the focus ring against every surface it sits on.
    for (const surface of SURFACES[mode]) {
      expect(contrast(scheme.primary, grey(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

it('writes only the accent tokens, never a surface', () => {
  expect(Object.keys(ACCENT_TOKEN_ROLES).sort()).toEqual(
    ['--accent-link', '--primary', '--primary-foreground', '--ring']
  );
  expect(Hct.fromInt(accentScheme('blue', true).primary).chroma).toBeGreaterThan(0);
});
