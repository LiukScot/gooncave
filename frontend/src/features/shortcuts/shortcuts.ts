/**
 * Every action a key can be bound to. Split by context: the same key may sit
 * on a detail action and on a dialog action without clashing, because a
 * dialog swallows the detail shortcuts while it is open.
 */
export const SHORTCUT_ACTIONS = [
  'prev',
  'next',
  'close',
  'fullscreen',
  'voteUp',
  'voteDown',
  'delete',
  'dialogConfirm',
  'dialogCancel'
] as const;

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export type ShortcutContext = 'detail' | 'dialog';

export type ShortcutBindings = Record<ShortcutAction, string>;

export const SHORTCUT_META: Record<
  ShortcutAction,
  { label: string; context: ShortcutContext }
> = {
  prev: { label: 'Previous file', context: 'detail' },
  next: { label: 'Next file', context: 'detail' },
  close: { label: 'Close / leave fullscreen', context: 'detail' },
  fullscreen: { label: 'Toggle fullscreen', context: 'detail' },
  voteUp: { label: 'Vote up', context: 'detail' },
  voteDown: { label: 'Vote down', context: 'detail' },
  delete: { label: 'Delete file', context: 'detail' },
  dialogConfirm: { label: 'Confirm dialog', context: 'dialog' },
  dialogCancel: { label: 'Dismiss dialog', context: 'dialog' }
};

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  prev: 'ArrowLeft',
  next: 'ArrowRight',
  close: 'Escape',
  fullscreen: ' ',
  voteUp: '+',
  voteDown: '-',
  delete: 'Delete',
  dialogConfirm: 'Enter',
  dialogCancel: 'Delete'
};

/**
 * The key as it should read in a tooltip or a settings row. `event.key`
 * carries a space for the space bar and single characters for the rest,
 * neither of which is legible on its own.
 */
export const formatShortcut = (key: string): string => {
  if (key === ' ') return 'Space';
  if (key === 'ArrowLeft') return '←';
  if (key === 'ArrowRight') return '→';
  if (key === 'ArrowUp') return '↑';
  if (key === 'ArrowDown') return '↓';
  if (key === 'Escape') return 'Esc';
  if (key === 'Delete') return 'Del';
  if (key.length === 1) return key.toUpperCase();
  return key;
};

/** Appends the bound key to a button's tooltip, per issue #282. */
export const withShortcutHint = (label: string, key?: string): string =>
  key ? `${label} (${formatShortcut(key)})` : label;

/**
 * Whether a keystroke should be considered at all.
 *
 * Ctrl, Meta and Alt are left to the browser so a binding can never shadow
 * Ctrl+F or ⌘W. Shift is allowed: on most layouts it is what produces `+`
 * in the first place.
 */
export const isBindableEvent = (event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  key: string;
}): boolean =>
  !event.ctrlKey &&
  !event.metaKey &&
  !event.altKey &&
  event.key !== 'Shift' &&
  event.key !== 'Control' &&
  event.key !== 'Alt' &&
  event.key !== 'Meta' &&
  event.key !== 'Tab';

/** The action a key triggers in one context, or null when nothing binds it. */
export const actionForKey = (
  bindings: ShortcutBindings,
  context: ShortcutContext,
  key: string
): ShortcutAction | null =>
  SHORTCUT_ACTIONS.find(
    (action) =>
      SHORTCUT_META[action].context === context && bindings[action] === key
  ) ?? null;

/** Actions sharing a key with `action`, which the settings page warns about. */
export const conflictsWith = (
  bindings: ShortcutBindings,
  action: ShortcutAction
): ShortcutAction[] =>
  SHORTCUT_ACTIONS.filter(
    (other) =>
      other !== action &&
      SHORTCUT_META[other].context === SHORTCUT_META[action].context &&
      bindings[other] === bindings[action]
  );

/**
 * Fills a stored map out to a complete set. Anything unknown or unusable is
 * replaced by its default, so a half-written row can never leave an action
 * unreachable.
 */
export const normaliseBindings = (stored: unknown): ShortcutBindings => {
  const bindings = { ...DEFAULT_SHORTCUTS };
  if (!stored || typeof stored !== 'object') return bindings;
  for (const action of SHORTCUT_ACTIONS) {
    const value = (stored as Record<string, unknown>)[action];
    if (typeof value === 'string' && value.length > 0) {
      bindings[action] = value;
    }
  }
  return bindings;
};
