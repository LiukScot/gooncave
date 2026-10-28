import { useCallback, useRef, type MutableRefObject } from 'react';

/**
 * The file Gallery's Prev/Next count from. It is the open file, except while
 * a pool navigator shows another saved page aside: the arrows then still step
 * past the file the reader started from.
 *
 * The anchor only changes when the open file does, so a render between
 * `markAside` and the file actually opening cannot reset it.
 */
export function useDetailAnchor(): {
  anchorRef: MutableRefObject<string | null>;
  /** Call on every render with the id of the file the detail view shows. */
  track: (selectedId: string | null) => void;
  markAside: (fileId: string) => void;
} {
  const anchorRef = useRef<string | null>(null);
  const asideRef = useRef<string | null>(null);
  const previousRef = useRef<string | null>(null);
  const track = useCallback((selectedId: string | null) => {
    if (selectedId === previousRef.current) return;
    previousRef.current = selectedId;
    if (selectedId === null || selectedId !== asideRef.current) {
      anchorRef.current = selectedId;
      asideRef.current = null;
    }
  }, []);
  const markAside = useCallback((fileId: string) => {
    asideRef.current = fileId;
  }, []);
  return { anchorRef, track, markAside };
}
