import { logDeveloper } from './windowErrorLog';

/** A return after this long away is logged even when the page looks fine. */
const LONG_AWAY_MS = 60_000;
/** Long enough for the page to draw again after the return. */
const SETTLE_MS = 1000;

const describe = (element: Element | null): string =>
  element ? `${element.tagName.toLowerCase()}${element.classList.length ? `.${[...element.classList].join('.')}` : ''}` : 'nothing';

/**
 * Logs what could keep taps from working after the app comes back from the background: a body
 * that refuses pointer events, inert content, open dialogs, and the element in the middle of the
 * screen, which is an overlay when one is left over.
 */
export const installResumeLog = () => {
  let hiddenAt: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = performance.now();
      return;
    }
    if (hiddenAt === null) return;
    const away = performance.now() - hiddenAt;
    hiddenAt = null;
    window.setTimeout(() => {
      // The app lock blocks the page on purpose.
      if (document.querySelector('.app-lock')) return;
      const blocked = getComputedStyle(document.body).pointerEvents === 'none';
      const inert = document.querySelectorAll('[inert]').length;
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;
      if (away < LONG_AWAY_MS && !blocked && inert === 0 && dialogs === 0) return;
      const middle = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      logDeveloper(
        `Back from the background after ${Math.round(away / 1000)} s on ${location.pathname}: ` +
          `body ${blocked ? 'refuses' : 'takes'} taps, ${inert} inert, ${dialogs} dialogs open, ` +
          `middle of the screen is ${describe(middle)}.`
      );
    }, SETTLE_MS);
  });
};
