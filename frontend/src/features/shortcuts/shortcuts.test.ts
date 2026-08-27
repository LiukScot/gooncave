import { describe, expect, it } from 'vitest';

import {
  actionForKey,
  conflictsWith,
  DEFAULT_SHORTCUTS,
  formatShortcut,
  isBindableEvent,
  normaliseBindings,
  SHORTCUT_ACTIONS,
  SHORTCUT_META,
  targetOwnsKey,
  withShortcutHint
} from './shortcuts';

const modifiers = { ctrlKey: false, metaKey: false, altKey: false };

describe('formatShortcut', () => {
  it('names the keys whose raw value is unreadable', () => {
    expect(formatShortcut(' ')).toBe('Space');
    expect(formatShortcut('ArrowLeft')).toBe('←');
    expect(formatShortcut('Escape')).toBe('Esc');
    expect(formatShortcut('Delete')).toBe('Del');
  });

  it('upper-cases a single character', () => {
    expect(formatShortcut('f')).toBe('F');
    expect(formatShortcut('+')).toBe('+');
  });
});

describe('DEFAULT_SHORTCUTS', () => {
  // Regression: fullscreen defaulted to the space bar. The detail handler
  // returns without preventDefault when ' ' or Enter reaches a focused
  // button, link or video, so those controls keep their native activation
  // — which left fullscreen unreachable from the key bound to it.
  //
  // playPause is the one action allowed on space, because the native
  // behaviour it falls through to is the play/pause it already promises.
  it('keeps detail actions off the keys focused controls consume', () => {
    const consumedByControls = [' ', 'Enter'];
    const clashing = SHORTCUT_ACTIONS.filter(
      (action) =>
        action !== 'playPause' &&
        SHORTCUT_META[action].context === 'detail' &&
        consumedByControls.includes(DEFAULT_SHORTCUTS[action])
    );
    expect(clashing).toEqual([]);
  });

  it('leaves space to play/pause', () => {
    expect(DEFAULT_SHORTCUTS.playPause).toBe(' ');
    expect(conflictsWith(DEFAULT_SHORTCUTS, 'playPause')).toEqual([]);
  });
});

describe('normaliseBindings retiring a stale key', () => {
  // A profile saved before play/pause existed still carries fullscreen on
  // space. actionForKey answers with the first match in SHORTCUT_ACTIONS
  // order, and fullscreen precedes playPause, so honouring the stored value
  // would leave play/pause unreachable on that account.
  it('drops a saved fullscreen-on-space back to the default', () => {
    const bindings = normaliseBindings({ fullscreen: ' ' });
    expect(bindings.fullscreen).toBe(DEFAULT_SHORTCUTS.fullscreen);
    expect(actionForKey(bindings, 'detail', ' ')).toBe('playPause');
  });

  it('keeps any other saved fullscreen key', () => {
    expect(normaliseBindings({ fullscreen: 'z' }).fullscreen).toBe('z');
  });

  it('still allows space on the action that owns it', () => {
    expect(normaliseBindings({ playPause: ' ' }).playPause).toBe(' ');
  });
});

describe('withShortcutHint', () => {
  it('appends the bound key to the label', () => {
    expect(withShortcutHint('Vote up', '+')).toBe('Vote up (+)');
  });

  it('leaves the label alone when nothing is bound', () => {
    expect(withShortcutHint('Vote up', undefined)).toBe('Vote up');
  });
});

describe('isBindableEvent', () => {
  it('ignores a keystroke the browser owns', () => {
    expect(isBindableEvent({ ...modifiers, ctrlKey: true, key: 'f' })).toBe(
      false
    );
    expect(isBindableEvent({ ...modifiers, metaKey: true, key: 'w' })).toBe(
      false
    );
  });

  it('allows shift, which is what produces + on most layouts', () => {
    expect(isBindableEvent({ ...modifiers, key: '+' })).toBe(true);
  });

  it('ignores a bare modifier and Tab', () => {
    expect(isBindableEvent({ ...modifiers, key: 'Shift' })).toBe(false);
    expect(isBindableEvent({ ...modifiers, key: 'Tab' })).toBe(false);
  });
});

describe('actionForKey', () => {
  it('resolves a key inside its own context', () => {
    expect(actionForKey(DEFAULT_SHORTCUTS, 'detail', 'ArrowLeft')).toBe('prev');
    expect(actionForKey(DEFAULT_SHORTCUTS, 'dialog', 'Enter')).toBe(
      'dialogConfirm'
    );
  });

  it('keeps the contexts apart: Canc deletes a file, or dismisses a dialog', () => {
    expect(actionForKey(DEFAULT_SHORTCUTS, 'detail', 'Delete')).toBe('delete');
    expect(actionForKey(DEFAULT_SHORTCUTS, 'dialog', 'Delete')).toBe(
      'dialogCancel'
    );
  });

  it('returns null for an unbound key', () => {
    expect(actionForKey(DEFAULT_SHORTCUTS, 'detail', 'q')).toBeNull();
  });
});

describe('conflictsWith', () => {
  it('reports nothing for the defaults', () => {
    expect(conflictsWith(DEFAULT_SHORTCUTS, 'delete')).toEqual([]);
  });

  it('reports two actions sharing a key in one context', () => {
    const bindings = { ...DEFAULT_SHORTCUTS, voteUp: 'ArrowLeft' };
    expect(conflictsWith(bindings, 'voteUp')).toEqual(['prev']);
  });

  it('does not report a key shared across contexts', () => {
    // `Delete` is the default for both, and neither shadows the other.
    expect(conflictsWith(DEFAULT_SHORTCUTS, 'dialogCancel')).toEqual([]);
  });
});

describe('normaliseBindings', () => {
  it('fills a partial map out with the defaults', () => {
    const bindings = normaliseBindings({ prev: 'a' });
    expect(bindings.prev).toBe('a');
    expect(bindings.next).toBe(DEFAULT_SHORTCUTS.next);
  });

  it('ignores unknown actions and unusable values', () => {
    const bindings = normaliseBindings({ nonsense: 'x', prev: '', next: 7 });
    expect(bindings.prev).toBe(DEFAULT_SHORTCUTS.prev);
    expect(bindings.next).toBe(DEFAULT_SHORTCUTS.next);
    expect('nonsense' in bindings).toBe(false);
  });

  it('falls back to the defaults for anything that is not a map', () => {
    expect(normaliseBindings(null)).toEqual(DEFAULT_SHORTCUTS);
    expect(normaliseBindings('broken')).toEqual(DEFAULT_SHORTCUTS);
  });
});

const focused = (tagName: string, isContentEditable = false) => ({
  tagName,
  isContentEditable
});

describe('targetOwnsKey', () => {
  it('gives a text field every key', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(targetOwnsKey(focused(tag), 'ArrowLeft')).toBe(true);
      expect(targetOwnsKey(focused(tag), 'f')).toBe(true);
    }
    expect(targetOwnsKey(focused('DIV', true), 'ArrowRight')).toBe(true);
  });

  it('gives a control only the keys that activate it', () => {
    for (const tag of ['BUTTON', 'A', 'VIDEO']) {
      expect(targetOwnsKey(focused(tag), ' ')).toBe(true);
      expect(targetOwnsKey(focused(tag), 'Enter')).toBe(true);
      // Clicking a control leaves it focused; taking the arrows too would
      // break navigation for the rest of the visit.
      expect(targetOwnsKey(focused(tag), 'ArrowRight')).toBe(false);
      expect(targetOwnsKey(focused(tag), 'f')).toBe(false);
    }
  });

  it('claims nothing for ordinary elements or a missing target', () => {
    expect(targetOwnsKey(focused('DIV'), ' ')).toBe(false);
    expect(targetOwnsKey(focused('BODY'), ' ')).toBe(false);
    expect(targetOwnsKey(null, ' ')).toBe(false);
  });
});
