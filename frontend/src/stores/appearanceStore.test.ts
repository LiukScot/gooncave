// @vitest-environment happy-dom

import { expect, it } from 'vitest';

import { DEFAULT_APPEARANCE, isDark, parseAppearance } from './appearanceStore';

it('reads a saved choice and falls back field by field', () => {
  expect(parseAppearance('{"mode":"light","style":"apple","accent":"tint-3"}')).toEqual({
    mode: 'light',
    style: 'apple',
    accent: 'tint-3'
  });
  expect(parseAppearance('{"mode":"sepia","style":"apple","accent":"tint-12"}')).toEqual({
    mode: DEFAULT_APPEARANCE.mode,
    style: 'apple',
    accent: DEFAULT_APPEARANCE.accent
  });
  expect(parseAppearance('not json')).toEqual(DEFAULT_APPEARANCE);
  expect(parseAppearance('null')).toEqual(DEFAULT_APPEARANCE);
  expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
});

it('follows the device only in system mode', () => {
  expect(isDark({ mode: 'system', systemDark: false })).toBe(false);
  expect(isDark({ mode: 'system', systemDark: true })).toBe(true);
  expect(isDark({ mode: 'light', systemDark: true })).toBe(false);
  expect(isDark({ mode: 'dark', systemDark: false })).toBe(true);
});
