import {
  type DynamicScheme,
  Hct,
  SchemeExpressive,
  SchemeMonochrome,
  blueFromArgb,
  greenFromArgb,
  redFromArgb
} from '@material/material-color-utilities';

import { type AppearanceAccent, accentSeed } from '@/lib/accents';
import { isDark, useAppearanceStore } from '@/stores/appearanceStore';

const NO_EXTRA_CONTRAST = 0;

/** `H S% L%`, the shape every colour token in index.css is written in. */
const hslTriple = (argb: number): string => {
  const r = redFromArgb(argb) / 255;
  const g = greenFromArgb(argb) / 255;
  const b = blueFromArgb(argb) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const span = max - min;
  let hue = 0;
  let saturation = 0;
  if (span > 0) {
    saturation = span / (1 - Math.abs(2 * lightness - 1));
    if (max === r) hue = ((g - b) / span) % 6;
    else if (max === g) hue = (b - r) / span + 2;
    else hue = (r - g) / span + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return `${hue.toFixed(1)} ${(saturation * 100).toFixed(1)}% ${(lightness * 100).toFixed(1)}%`;
};

/**
 * The tokens the chosen colour fills: the ones selected and emphasised
 * elements wear. Every surface keeps the fixed greys of index.css, so a
 * different colour never changes a background.
 */
export const ACCENT_TOKEN_ROLES: Record<string, (scheme: DynamicScheme) => number> = {
  '--primary': (s) => s.primary,
  '--primary-foreground': (s) => s.onPrimary,
  '--ring': (s) => s.primary,
  '--accent-link': (s) => s.primary
};

/** The accent scheme for a colour choice: Material 3 Expressive, or the monochrome one for black and white. */
export const accentScheme = (accent: AppearanceAccent, dark: boolean): DynamicScheme => {
  const seed = Hct.fromInt(accentSeed(accent));
  return accent === 'mono'
    ? new SchemeMonochrome(seed, dark, NO_EXTRA_CONTRAST, '2025')
    : new SchemeExpressive(seed, dark, NO_EXTRA_CONTRAST, '2025');
};

/**
 * Puts the chosen mode and colour on the page: the `dark` class Tailwind's
 * `dark:` variant reads, the browser's colour scheme, and the accent tokens.
 */
export const applyAppearance = (): void => {
  const state = useAppearanceStore.getState();
  const root = document.documentElement;
  const dark = isDark(state);
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  const scheme = accentScheme(state.accent, dark);
  for (const [token, role] of Object.entries(ACCENT_TOKEN_ROLES)) {
    root.style.setProperty(token, hslTriple(role(scheme)));
  }
  // The browser's own toolbar on phones takes the page's colour.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      `hsl(${getComputedStyle(root).getPropertyValue('--page-background').trim()})`
    );
};
