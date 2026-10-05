import {
  type DynamicScheme,
  Hct,
  SchemeExpressive,
  SchemeMonochrome,
  SchemeVibrant,
  blueFromArgb,
  greenFromArgb,
  redFromArgb,
  sourceColorFromImage
} from '@material/material-color-utilities';
import { useEffect } from 'react';

import { accentSeed, appleAccent } from '@/lib/accents';
import { placeIndicators } from '@/lib/glassMotion';
import { isDark, useAppearanceStore } from '@/stores/appearanceStore';

/**
 * Material 3 colour for the app's tokens. One seed colour becomes a whole
 * light or dark scheme, and each role of that scheme is written into the token the
 * components already read (see index.css), so nothing downstream changes.
 */

const NO_EXTRA_CONTRAST = 0;

const MEDIA_BAND_MAX_CHROMA = 24;

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

/** Which Material role fills which of the app's tokens. */
const TOKEN_ROLES: Record<string, (scheme: DynamicScheme) => number> = {
  '--page-background': (s) => s.surface,
  '--background': (s) => s.surfaceContainerHigh,
  '--foreground': (s) => s.onSurface,
  '--foreground-soft': (s) => s.onSurface,
  '--card': (s) => s.surfaceContainerLow,
  '--card-foreground': (s) => s.onSurface,
  '--popover': (s) => s.surfaceContainer,
  '--popover-foreground': (s) => s.onSurface,
  '--primary': (s) => s.primary,
  '--primary-foreground': (s) => s.onPrimary,
  '--secondary': (s) => s.secondaryContainer,
  '--secondary-foreground': (s) => s.onSecondaryContainer,
  '--muted': (s) => s.surfaceContainerHighest,
  '--muted-foreground': (s) => s.onSurfaceVariant,
  '--accent': (s) => s.tertiaryContainer,
  '--accent-foreground': (s) => s.onTertiaryContainer,
  '--destructive': (s) => s.error,
  '--destructive-foreground': (s) => s.onError,
  '--border': (s) => s.outlineVariant,
  '--input': (s) => s.outline,
  '--ring': (s) => s.primary,
  '--accent-link': (s) => s.primary,
  '--color-surface': (s) => s.surfaceContainerHigh,
  '--color-surface-elevated': (s) => s.surfaceContainerLow,
  '--color-surface-sunken': (s) => s.surfaceContainerLowest,
  // The band behind a picture: the accent's own hue, deep in dark and pale
  // in light, so the viewer wears the colour around the art. Its strength
  // is capped: a picture's vibrant palette would otherwise paint the band
  // rather than tint it.
  '--surface-media': (s) =>
    Hct.from(
      s.primaryPalette.hue,
      Math.min(s.primaryPalette.chroma, MEDIA_BAND_MAX_CHROMA),
      s.isDark ? 12 : 88
    ).toInt(),
  '--surface-card-raised': (s) => s.surfaceContainer,
  '--section': (s) => s.surfaceContainer
};

// A light scheme's own surface is all but white. The page takes the next
// container up, which carries the seed's hue, and cards stay lighter on it.
const LIGHT_TOKEN_ROLES: Record<string, (scheme: DynamicScheme) => number> = {
  '--page-background': (s) => s.surfaceContainer,
  '--color-surface-sunken': (s) => s.surfaceContainer,
  '--section': (s) => s.surfaceContainerLowest
};

const apply = (scheme: DynamicScheme): void => {
  const { style } = document.documentElement;
  const roles = scheme.isDark ? TOKEN_ROLES : { ...TOKEN_ROLES, ...LIGHT_TOKEN_ROLES };
  for (const [token, role] of Object.entries(roles)) {
    style.setProperty(token, hslTriple(role(scheme)));
  }
};

// Styles other than Material keep their colours in index.css, which the
// inline values written by apply() would override.
const clear = (): void => {
  const { style } = document.documentElement;
  for (const token of Object.keys(TOKEN_ROLES)) style.removeProperty(token);
};

const usesMaterial = (): boolean => useAppearanceStore.getState().style === 'material';

const dark = (): boolean => isDark(useAppearanceStore.getState());

// Apple and Custom keep their own colours from index.css and take only the
// accent: the open picture's, else the chosen one. Ink on the accent
// follows its lightness; link text on a light page is darkened to stay
// readable. Custom with its default blue keeps the original look's own
// blue, which index.css already holds.
const applyAccentOnly = (pictureArgb: number | null = null): void => {
  clear();
  const { style: appStyle, accent } = useAppearanceStore.getState();
  if (appStyle === 'custom' && accent === 'blue' && pictureArgb === null) return;
  const isDarkNow = dark();
  const argb = appleAccent(useAppearanceStore.getState().accent, isDarkNow, pictureArgb);
  const { style } = document.documentElement;
  style.setProperty('--primary', hslTriple(argb));
  style.setProperty('--ring', hslTriple(argb));
  style.setProperty(
    '--primary-foreground',
    Hct.fromInt(argb).tone > 60 ? '0 0% 0%' : '0 0% 100%'
  );
  const tone = Hct.fromInt(argb);
  if (!isDarkNow && tone.tone > 45) tone.tone = 45;
  style.setProperty('--accent-link', hslTriple(tone.toInt()));
};

/**
 * The app-wide scheme: Material 3 Expressive from the accent, or the
 * monochrome scheme for black and white.
 */
export const applyBaseTheme = (): void => {
  if (!usesMaterial()) {
    applyAccentOnly();
    return;
  }
  const { accent } = useAppearanceStore.getState();
  const seed = Hct.fromInt(accentSeed(accent));
  apply(
    accent === 'mono'
      ? new SchemeMonochrome(seed, dark(), NO_EXTRA_CONTRAST, '2025')
      : new SchemeExpressive(seed, dark(), NO_EXTRA_CONTRAST, '2025')
  );
};

/**
 * The picture's hue at full strength. A scheme faithful to the picture's own
 * chroma turns grey for the many images whose dominant colour is pale skin
 * or paper, and the page then looks untinted.
 */
const applyImageTheme = (sourceArgb: number): void => {
  if (!usesMaterial()) {
    applyAccentOnly(sourceArgb);
    return;
  }
  apply(
    new SchemeVibrant(
      Hct.fromInt(sourceArgb),
      dark(),
      NO_EXTRA_CONTRAST,
      '2025'
    )
  );
};

const paintAppearance = (): void => {
  const state = useAppearanceStore.getState();
  const root = document.documentElement;
  const isDarkNow = isDark(state);
  root.classList.toggle('dark', isDarkNow);
  root.dataset.style = state.style;
  root.dataset.accent = state.accent;
  root.style.colorScheme = isDarkNow ? 'dark' : 'light';
  applyBaseTheme();
  // The browser's own toolbar on phones takes the page's colour.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      `hsl(${getComputedStyle(root).getPropertyValue('--page-background').trim()})`
    );
};

// How long the tab bar takes to drop out of sight: the .app-tab-bar
// transition in app.css.
const TAB_BAR_EXIT_MS = 250;
let restyleTimer: number | undefined;

/**
 * Puts the chosen mode and style on the page: the `dark` class Tailwind's
 * `dark:` variant reads, `data-style` and `data-accent` for the CSS that
 * depends on them, the browser's colour scheme, and the base colours.
 *
 * A change of style moves the tab bar to another place on screen. Rather
 * than let it glide across, the bar drops away (`data-restyling`), the new
 * style goes on while it is out of sight, and it rises back.
 */
export const applyAppearance = (): void => {
  const root = document.documentElement;
  const styleChanges =
    root.dataset.style !== undefined &&
    root.dataset.style !== useAppearanceStore.getState().style;
  const animate =
    styleChanges &&
    document.querySelector('.app-tab-bar') !== null &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.clearTimeout(restyleTimer);
  if (!animate) {
    paintAppearance();
    return;
  }
  root.dataset.restyling = '';
  restyleTimer = window.setTimeout(() => {
    paintAppearance();
    // Everything in the bar takes its new size at once while it is out of
    // sight (app.css turns its transitions off meanwhile), and the pill is
    // placed on that finished layout, so the bar rises already settled.
    // Reading the layout does the settling: a frame callback would too, but
    // never runs in a background tab and would leave the bar hidden.
    void root.offsetWidth;
    placeIndicators();
    void root.offsetWidth;
    delete root.dataset.restyling;
  }, TAB_BAR_EXIT_MS);
};

// Swiping back to a file should not decode its thumbnail again.
const sourceColors = new Map<string, Promise<number | null>>();

const sourceColorOf = (url: string): Promise<number | null> => {
  let pending = sourceColors.get(url);
  if (!pending) {
    pending = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    })
      .then(sourceColorFromImage)
      // An image from another origin cannot be read back from a canvas; the
      // page then keeps the base colours.
      .catch(() => null);
    sourceColors.set(url, pending);
  }
  return pending;
};

/**
 * Tints the whole app from one image for as long as the caller is mounted,
 * and hands the base colours back when it leaves. Changing image keeps the
 * previous tint until the new one is ready, so a swipe does not flash the
 * base colours in between. A change of mode, style or accent tints again,
 * so the picture keeps the last word.
 */
export const useImageTheme = (imageUrl: string | null): void => {
  const style = useAppearanceStore((state) => state.style);
  const accent = useAppearanceStore((state) => state.accent);
  const isDarkNow = useAppearanceStore(isDark);
  useEffect(() => {
    if (!imageUrl) {
      applyBaseTheme();
      return;
    }
    let current = true;
    void sourceColorOf(imageUrl).then((argb) => {
      if (!current) return;
      if (argb === null) applyBaseTheme();
      else applyImageTheme(argb);
    });
    return () => {
      current = false;
    };
  }, [imageUrl, style, accent, isDarkNow]);

  useEffect(() => applyBaseTheme, []);
};
