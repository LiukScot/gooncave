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
