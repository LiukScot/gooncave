// @vitest-environment happy-dom

import { expect, it } from 'vitest';

import { DEFAULT_APPEARANCE, isDark, parseAppearance } from './appearanceStore';

it('reads a saved choice and falls back field by field', () => {
  expect(parseAppearance('{"mode":"light","accent":"tint-3"}')).toEqual({
    mode: 'light',
    accent: 'tint-3',
    quickActions: DEFAULT_APPEARANCE.quickActions
  });
  expect(parseAppearance('{"mode":"sepia","accent":"tint-12"}')).toEqual(DEFAULT_APPEARANCE);
  // A device on an older version may still save the removed Apple and Custom styles.
  expect(parseAppearance('{"mode":"dark","style":"apple","accent":"blue"}')).toEqual({
    mode: 'dark',
    accent: 'blue',
    quickActions: DEFAULT_APPEARANCE.quickActions
  });
  // A device may still have the removed black and white saved.
  expect(parseAppearance('{"accent":"mono"}').accent).toBe(DEFAULT_APPEARANCE.accent);
  expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE);
  expect(parseAppearance('null')).toEqual(DEFAULT_APPEARANCE);
  expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
});

it('keeps each page\'s quick button only when that page offers it', () => {
  const saved = JSON.stringify({ quickActions: { gallery: 'sync', file: 'favorite', post: 'share' } });
  expect(parseAppearance(saved).quickActions).toEqual({
    gallery: 'sync',
    explore: DEFAULT_APPEARANCE.quickActions.explore,
    file: DEFAULT_APPEARANCE.quickActions.file,
    post: 'share'
  });
});

it('follows the device only in system mode', () => {
  expect(isDark({ mode: 'system', systemDark: false })).toBe(false);
  expect(isDark({ mode: 'system', systemDark: true })).toBe(true);
  expect(isDark({ mode: 'light', systemDark: true })).toBe(false);
  expect(isDark({ mode: 'dark', systemDark: false })).toBe(true);
});
