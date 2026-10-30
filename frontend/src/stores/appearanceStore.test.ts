// @vitest-environment happy-dom

import { expect, it } from 'vitest';

import { DEFAULT_APPEARANCE, isDark, parseAppearance } from './appearanceStore';

it('reads a saved choice and falls back field by field', () => {
  expect(parseAppearance('{"mode":"light","accent":"tint-3"}')).toEqual({
    mode: 'light',
    accent: 'tint-3'
  });
  expect(parseAppearance('{"mode":"sepia","accent":"tint-12"}')).toEqual({
    mode: DEFAULT_APPEARANCE.mode,
    accent: DEFAULT_APPEARANCE.accent
  });
  // A device on an older version may still save the removed Apple and Custom styles.
  expect(parseAppearance('{"mode":"dark","style":"apple","accent":"blue"}')).toEqual({
    mode: 'dark',
    accent: 'blue'
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
