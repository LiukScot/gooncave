import { Hct, argbFromHex, hexFromArgb } from '@material/material-color-utilities';

/**
 * The accent choices, in the order the picker shows them: the two basics,
 * then the tints from red round to purple.
 */
export const TINT_COUNT = 12;

export type AppearanceAccent = 'mono' | 'blue' | `tint-${number}`;

export const TINT_ACCENTS = Array.from(
  { length: TINT_COUNT },
  (_, index) => `tint-${index}` as AppearanceAccent
);

export const ACCENT_IDS: readonly AppearanceAccent[] = [
  'mono',
  'blue',
  ...TINT_ACCENTS
];

// The app's own blue.
const BLUE_SEED = argbFromHex('#8bb5f8');

// Red (HCT hue 20) to purple (320) in even steps.
const FIRST_HUE = 20;
const LAST_HUE = 320;

const tintIndex = (accent: AppearanceAccent): number | null =>
  accent.startsWith('tint-') ? Number(accent.slice(5)) : null;

const tintHue = (index: number): number =>
  FIRST_HUE + (index * (LAST_HUE - FIRST_HUE)) / (TINT_COUNT - 1);

const HUE_NAMES: [number, string][] = [
  [45, 'red'],
  [75, 'orange'],
  [110, 'yellow'],
  [135, 'lime'],
  [165, 'green'],
  [205, 'teal'],
  [235, 'cyan'],
  [275, 'blue'],
  [300, 'violet'],
  [360, 'purple']
];

export const accentLabel = (accent: AppearanceAccent): string => {
  if (accent === 'mono') return 'Black and white';
  if (accent === 'blue') return 'Blue';
  const index = tintIndex(accent) ?? 0;
  const hue = tintHue(index);
  const name = HUE_NAMES.find(([limit]) => hue < limit)?.[1] ?? 'purple';
  return `Pastel ${name} (${index + 1} of ${TINT_COUNT})`;
};

/** What a swatch is painted with: the pastel itself, as a CSS colour. */
export const accentSwatch = (accent: AppearanceAccent): string => {
  const index = tintIndex(accent);
  if (index === null) return hexFromArgb(BLUE_SEED);
  return hexFromArgb(Hct.from(tintHue(index), 40, 80).toInt());
};

/** The seed the accent colours grow from. `mono` uses its own scheme. */
export const accentSeed = (accent: AppearanceAccent): number => {
  const index = tintIndex(accent);
  return index === null ? BLUE_SEED : Hct.from(tintHue(index), 48, 70).toInt();
};
