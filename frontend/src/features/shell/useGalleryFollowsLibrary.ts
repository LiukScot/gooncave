import { useEffect, useRef } from 'react';

// Past this the reader is looking at files that a new one on top would push down.
const TOP_OF_PAGE_PX = 8;
const atTop = () => window.scrollY <= TOP_OF_PAGE_PX;

/**
 * Keeps the gallery current with every change to the library, whichever job,
 * sync or screen made it.
 *
 * `version` is the core's library version, which moves on every write the
 * gallery shows. While `onGallery`, each new value calls `refresh`:
 * - with `keepPlace` false when the gallery is `showing` and the reader is at
 *   the top, so new files appear first;
 * - otherwise with `keepPlace` set, so nothing moves under a reader who
 *   scrolled or opened a file. The new files then wait, and come in once the
 *   reader is back at the top of the gallery.
 *
 * Away from the gallery nothing runs: arriving on it fetches anyway.
 */
export function useGalleryFollowsLibrary(
  version: number | undefined,
  onGallery: boolean,
  showing: boolean,
  refresh: (keepPlace: boolean) => void
): void {
  const seen = useRef<number | null>(null);
  const waiting = useRef(false);
  const latest = useRef({ showing, refresh });
  latest.current = { showing, refresh };

  useEffect(() => {
    if (!onGallery) {
      seen.current = null;
      waiting.current = false;
      return;
    }
    if (version === undefined) return;
    const before = seen.current;
    seen.current = version;
    if (before === null || before === version) return;
    const here = latest.current.showing && atTop();
    waiting.current = !here;
    latest.current.refresh(!here);
  }, [version, onGallery]);

  // Coming back to the top, or closing a file opened from there, shows what waited.
  useEffect(() => {
    if (!showing) return;
    const show = () => {
      if (!waiting.current || !atTop()) return;
      waiting.current = false;
      latest.current.refresh(false);
    };
    show();
    window.addEventListener('scroll', show, { passive: true });
    return () => window.removeEventListener('scroll', show);
  }, [showing]);
}
