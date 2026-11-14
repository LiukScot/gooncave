import { api } from '@/api';

const TOUCHABLE =
  'button, a[href], [role=button], [role=switch], [role=checkbox], [role=menuitem], [role=option], [role=tab], [role=slider], input, select, label, summary';

/** A tap that also changes a value (a checkbox, a radio) gives one haptic, not two. */
export const PRESS_CHANGE_MS = 600;

/** Gives a haptic on touch controls and value changes. Returns the cleanup. */
export function listenForHaptics(impact: () => Promise<void> = api.hapticImpact): () => void {
  let lastPress = -Infinity;
  let stopped = false;

  const tap = () => {
    if (stopped) return;
    impact().catch((error: unknown) => {
      stopped = true;
      console.error('[developer] The iPhone gave no haptic feedback; it is off for this session', error);
    });
  };
  // On click, not pointerdown: a finger that lands on a tile to scroll the grid presses a
  // button too, and only a tap that ends on the control is a click.
  const press = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const element = event.target.closest(TOUCHABLE);
    if (!element || element.matches(':disabled') || element.closest('fieldset:disabled')) return;
    lastPress = performance.now();
    tap();
  };
  const change = (event: Event) => {
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) return;
    if (performance.now() - lastPress >= PRESS_CHANGE_MS) tap();
  };

  window.addEventListener('click', press, true);
  window.addEventListener('change', change, true);
  return () => {
    window.removeEventListener('click', press, true);
    window.removeEventListener('change', change, true);
  };
}
