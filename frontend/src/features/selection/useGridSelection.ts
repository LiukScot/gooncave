import { useCallback, useEffect, useRef, useState } from 'react';

/** How long a finger rests on a tile before it starts selecting. */
export const LONG_PRESS_MS = 500;
/** A finger that moves farther than this is scrolling, not pressing. */
const PRESS_SLOP_PX = 10;

const tileOf = (target: EventTarget | null): string | null =>
  target instanceof Element
    ? target.closest<HTMLElement>('[data-select-key]')?.dataset.selectKey ?? null
    : null;

/**
 * Selection mode for a grid of tiles marked with `data-select-key`. A long press on a tile,
 * or Ctrl/Cmd/Shift-click, starts it; while it is on, a tap toggles a tile instead of opening
 * it. Spread `gridProps` on the element around the tiles. Leaving with no tile selected,
 * Escape or `exit` ends it.
 */
export function useGridSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const active = selected.size > 0;
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  // The click that ends a long press would otherwise open the tile it selected.
  const swallowClick = useRef(false);

  const toggle = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const exit = useCallback(() => setSelected(new Set()), []);
  const selectAll = useCallback((keys: readonly string[]) => setSelected(new Set(keys)), []);

  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      // Escape in a dialog asked by an action closes only that dialog.
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"], [role="alertdialog"]')) exit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, exit]);

  const gridProps = {
    onPointerDownCapture: (event: React.PointerEvent) => {
      cancelPress();
      swallowClick.current = false;
      if (event.button !== 0) return;
      const key = tileOf(event.target);
      if (!key) return;
      press.current = {
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
          press.current = null;
          swallowClick.current = true;
          navigator.vibrate?.(10);
          toggle(key);
        }, LONG_PRESS_MS)
      };
    },
    onPointerMoveCapture: (event: React.PointerEvent) => {
      const start = press.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > PRESS_SLOP_PX) {
        cancelPress();
      }
    },
    onPointerUpCapture: cancelPress,
    onPointerCancelCapture: cancelPress,
    onClickCapture: (event: React.MouseEvent) => {
      const key = tileOf(event.target);
      const modified = event.ctrlKey || event.metaKey || event.shiftKey;
      if (!swallowClick.current && !(key && (active || modified))) return;
      event.preventDefault();
      event.stopPropagation();
      if (!swallowClick.current && key) toggle(key);
      swallowClick.current = false;
    },
    // A long press also opens the browser's image menu; selecting takes its place.
    onContextMenuCapture: (event: React.MouseEvent) => {
      if (press.current || swallowClick.current || active) event.preventDefault();
    }
  };

  return { active, selected, toggle, selectAll, exit, gridProps };
}
