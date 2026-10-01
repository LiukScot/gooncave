import {
  type DynamicScheme,
  Hct,
  SchemeExpressive,
  SchemeVibrant,
  argbFromHex,
  blueFromArgb,
  greenFromArgb,
  redFromArgb,
  sourceColorFromImage
} from '@material/material-color-utilities';
import { useEffect } from 'react';

/**
 * Material 3 colour for the app's tokens. One seed colour becomes a whole
 * dark scheme, and each role of that scheme is written into the token the
 * components already read (see index.css), so nothing downstream changes.
 */

// The app's seed until a preference exists. A browser cannot read Android's
// wallpaper colour, so there it is this one too.
const BASE_SEED = '#8bb5f8';

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

/** Which Material role fills which of the app's tokens. */
const tokensOf = (scheme: DynamicScheme): Record<string, number> => ({
  '--page-background': scheme.surface,
  '--background': scheme.surfaceContainerHigh,
  '--foreground': scheme.onSurface,
  '--foreground-soft': scheme.onSurface,
  '--card': scheme.surfaceContainerLow,
  '--card-foreground': scheme.onSurface,
  '--popover': scheme.surfaceContainer,
  '--popover-foreground': scheme.onSurface,
  '--primary': scheme.primary,
  '--primary-foreground': scheme.onPrimary,
  '--secondary': scheme.secondaryContainer,
  '--secondary-foreground': scheme.onSecondaryContainer,
  '--muted': scheme.surfaceContainerHighest,
  '--muted-foreground': scheme.onSurfaceVariant,
  '--accent': scheme.tertiaryContainer,
  '--accent-foreground': scheme.onTertiaryContainer,
  '--destructive': scheme.error,
  '--destructive-foreground': scheme.onError,
  '--border': scheme.outlineVariant,
  '--input': scheme.outline,
  '--ring': scheme.primary,
  '--accent-link': scheme.primary,
  '--color-surface': scheme.surfaceContainerHigh,
  '--color-surface-elevated': scheme.surfaceContainerLow,
  '--color-surface-sunken': scheme.surfaceContainerLowest,
  '--surface-media': scheme.surfaceContainerLowest,
  '--surface-card-raised': scheme.surfaceContainer
});

const apply = (scheme: DynamicScheme): void => {
  const { style } = document.documentElement;
  for (const [token, argb] of Object.entries(tokensOf(scheme))) {
    style.setProperty(token, hslTriple(argb));
  }
};

/** The app-wide scheme: Material 3 Expressive, from the seed. */
export const applyBaseTheme = (): void =>
  apply(
    new SchemeExpressive(
      Hct.fromInt(argbFromHex(BASE_SEED)),
      true,
      NO_EXTRA_CONTRAST,
      '2025'
    )
  );

/**
 * The picture's hue at full strength. A scheme faithful to the picture's own
 * chroma turns grey for the many images whose dominant colour is pale skin
 * or paper, and the page then looks untinted.
 */
const applyImageTheme = (sourceArgb: number): void =>
  apply(
    new SchemeVibrant(
      Hct.fromInt(sourceArgb),
      true,
      NO_EXTRA_CONTRAST,
      '2025'
    )
  );

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
 * base colours in between.
 */
export const useImageTheme = (imageUrl: string | null): void => {
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
  }, [imageUrl]);

  useEffect(() => applyBaseTheme, []);
};
